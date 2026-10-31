import { useEffect, useRef, useState } from 'react';
import type { PromptGeneration, PromptGenerationRequest } from '../shared/types';
import { api, ApiError } from './api';

export const isActivePromptGeneration = (job: PromptGeneration) =>
  job.status === 'queued' || job.status === 'generating';

function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues remains available on authenticated HTTP LAN installations.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Generation belongs to the server, so closing a profile only stops this observer. */
export function usePromptGenerations() {
  const [jobs, setJobs] = useState<PromptGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const pendingRequest = useRef<(PromptGenerationRequest & { requestId: string }) | undefined>(
    undefined,
  );
  const submitLock = useRef(false);
  const cancelLock = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const active = jobs.find(isActivePromptGeneration);

  const merge = (incoming: PromptGeneration[]) => {
    if (!mounted.current) return;
    setJobs((previous) => {
      const result = new Map(previous.map((job) => [job.id, job]));
      for (const job of incoming) {
        const old = result.get(job.id);
        if (old && !isActivePromptGeneration(old) && isActivePromptGeneration(job)) continue;
        if (
          !old ||
          job.updatedAt > old.updatedAt ||
          (job.updatedAt === old.updatedAt && isActivePromptGeneration(old))
        )
          result.set(job.id, job);
      }
      return [...result.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);
    });
    if (
      pendingRequest.current &&
      incoming.some((job) => job.id === pendingRequest.current?.requestId)
    ) {
      pendingRequest.current = undefined;
      setUncertain(false);
    }
  };
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      return await api<T>(
        path,
        method,
        body,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      );
    } finally {
      requests.current.delete(controller);
    }
  };
  const reload = async () => {
    const currentLifetime = lifetime.current;
    setLoading(true);
    try {
      const history = await request<PromptGeneration[]>('/prompt-generations');
      if (mounted.current && currentLifetime === lifetime.current) {
        merge(history);
        setError('');
      }
    } catch (cause) {
      if (mounted.current && currentLifetime === lifetime.current)
        setError((cause as Error).message);
    } finally {
      if (mounted.current && currentLifetime === lifetime.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    lifetime.current++;
    void reload();
    return () => {
      mounted.current = false;
      lifetime.current++;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await api<PromptGeneration>(
          `/prompt-generations/${active.id}`,
          'GET',
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        );
        if (!controller.signal.aborted) {
          merge([updated]);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted && mounted.current) setError((cause as Error).message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active?.id]);

  const generate = async (
    input: PromptGenerationRequest,
  ): Promise<PromptGeneration | undefined> => {
    if (submitLock.current || active || !input.instructions.trim()) return;
    const currentLifetime = lifetime.current;
    submitLock.current = true;
    setSubmitting(true);
    setError('');
    try {
      const body = pendingRequest.current ?? {
        requestId: newRequestId(),
        ...input,
      };
      pendingRequest.current = body;
      const job = await request<PromptGeneration>('/prompt-generations', 'POST', body);
      if (mounted.current && currentLifetime === lifetime.current) {
        merge([job]);
        return job;
      }
    } catch (cause) {
      if (mounted.current && currentLifetime === lifetime.current) {
        setError((cause as Error).message);
        if (cause instanceof ApiError && cause.status < 500) pendingRequest.current = undefined;
        setUncertain(Boolean(pendingRequest.current));
        if (cause instanceof ApiError && cause.status === 409) void reload();
      }
    } finally {
      submitLock.current = false;
      if (mounted.current && currentLifetime === lifetime.current) setSubmitting(false);
    }
  };
  const cancel = async () => {
    if (!active || cancelLock.current) return;
    const currentLifetime = lifetime.current;
    cancelLock.current = true;
    setCancelling(true);
    try {
      const job = await request<PromptGeneration>(`/prompt-generations/${active.id}`, 'DELETE');
      if (mounted.current && currentLifetime === lifetime.current) {
        merge([job]);
        setError('');
      }
    } catch (cause) {
      if (mounted.current && currentLifetime === lifetime.current)
        setError((cause as Error).message);
    } finally {
      cancelLock.current = false;
      if (mounted.current && currentLifetime === lifetime.current) setCancelling(false);
    }
  };
  return {
    jobs,
    active,
    loading,
    submitting,
    cancelling,
    error,
    uncertain,
    reload,
    generate,
    cancel,
  };
}
