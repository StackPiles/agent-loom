import { useEffect, useRef, useState } from 'react';
import {
  isActiveImageTest,
  type ImageTestJob,
  type ImageTestRequest,
  type ImageTestSettings,
} from '../shared/image-tests';
import { api, ApiError } from './api';

const requestTimeoutMs = 10_000;
const pollIntervalMs = 750;

function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function discard(id: string) {
  // A cancelled-ID receipt also prevents a delayed POST from starting later.
  void api(`/image-tests/${id}`, 'DELETE', undefined, AbortSignal.timeout(requestTimeoutMs)).catch(
    () => {},
  );
}

interface TestState {
  signature: string;
  job?: ImageTestJob;
  submitting: boolean;
  checking: boolean;
  cancelling: boolean;
  uncertain: boolean;
  error: string;
}
const emptyState = (signature: string): TestState => ({
  signature,
  submitting: false,
  checking: false,
  cancelling: false,
  uncertain: false,
  error: '',
});
interface Run {
  id: string;
  signature: string;
}

export function useImageTest(
  settings: ImageTestSettings,
  apiKey: string,
  keyDirty: boolean,
  networkDenied: boolean,
) {
  const signature = JSON.stringify({
    settings,
    apiKey: keyDirty ? apiKey : undefined,
    keyDirty,
    networkDenied,
  });
  const [state, setState] = useState<TestState>(() => emptyState(signature));
  const mounted = useRef(false);
  const epoch = useRef(0);
  const currentSignature = useRef(signature);
  currentSignature.current = signature;
  const current = useRef<Run | undefined>(undefined);
  const actionLock = useRef(false);
  const cancelLock = useRef(false);
  const requests = useRef(new Set<AbortController>());
  // Hide an old result in the render that changes the inputs, before effects run.
  const visible = state.signature === signature ? state : emptyState(signature);

  function stillCurrent(run: Run, generation: number) {
    return (
      mounted.current &&
      epoch.current === generation &&
      current.current === run &&
      currentSignature.current === run.signature
    );
  }
  function abortRequests() {
    for (const request of requests.current) request.abort();
    requests.current.clear();
  }
  async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const abort = new AbortController();
    requests.current.add(abort);
    try {
      return await api<T>(
        path,
        method,
        body,
        AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(requestTimeoutMs),
          ...(signal ? [signal] : []),
        ]),
      );
    } finally {
      requests.current.delete(abort);
    }
  }
  function receive(run: Run, job: ImageTestJob) {
    // Only a fresh generating response can expire polling. A queued job has
    // no generation deadline, and an old deadline must not hide a later result
    // when a background tab resumes polling.
    const deadline = job.status === 'generating' ? Date.parse(job.deadlineAt ?? '') : NaN;
    const expired = Number.isFinite(deadline) && Date.now() > deadline + 15_000;
    setState({ ...emptyState(run.signature), job, uncertain: expired });
    return isActiveImageTest(job) && !expired;
  }

  useEffect(() => {
    mounted.current = true;
    epoch.current++;
    setState(emptyState(signature));
    return () => {
      mounted.current = false;
      epoch.current++;
      abortRequests();
      actionLock.current = false;
      cancelLock.current = false;
      const previous = current.current;
      current.current = undefined;
      if (previous) discard(previous.id);
    };
  }, [signature]);

  useEffect(() => {
    const run = current.current;
    if (
      !run ||
      !visible.job ||
      !isActiveImageTest(visible.job) ||
      visible.submitting ||
      visible.checking ||
      visible.cancelling ||
      visible.uncertain
    )
      return;
    const generation = epoch.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!stillCurrent(run, generation) || abort.signal.aborted) return;
      try {
        const job = await request<ImageTestJob>(
          `/image-tests/${run.id}`,
          'GET',
          undefined,
          abort.signal,
        );
        if (stillCurrent(run, generation) && !abort.signal.aborted) {
          if (receive(run, job)) timer = setTimeout(poll, pollIntervalMs);
        }
      } catch (error) {
        if (stillCurrent(run, generation) && !abort.signal.aborted)
          setState((value) => ({ ...value, uncertain: true, error: (error as Error).message }));
      }
    };
    timer = setTimeout(poll, pollIntervalMs);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    signature,
    visible.job?.id,
    visible.job?.status,
    visible.submitting,
    visible.checking,
    visible.cancelling,
    visible.uncertain,
  ]);

  async function generate() {
    if (
      actionLock.current ||
      networkDenied ||
      visible.uncertain ||
      (visible.job && isActiveImageTest(visible.job))
    )
      return;
    actionLock.current = true;
    abortRequests();
    if (current.current) discard(current.current.id);
    const generation = ++epoch.current;
    const run: Run = {
      id: newRequestId(),
      signature,
    };
    current.current = run;
    setState({ ...emptyState(signature), submitting: true });
    const input: ImageTestRequest = {
      requestId: run.id,
      settings,
      ...(keyDirty ? { apiKey } : {}),
    };
    try {
      const job = await request<ImageTestJob>('/image-tests', 'POST', input);
      if (stillCurrent(run, generation)) receive(run, job);
    } catch (error) {
      if (stillCurrent(run, generation)) {
        const uncertain = !(error instanceof ApiError && error.status < 500);
        if (!uncertain) current.current = undefined;
        setState({ ...emptyState(signature), uncertain, error: (error as Error).message });
      }
    } finally {
      if (epoch.current === generation) actionLock.current = false;
    }
  }

  async function check() {
    const run = current.current;
    if (!run || actionLock.current) return;
    actionLock.current = true;
    const generation = epoch.current;
    setState((value) => ({ ...value, checking: true, error: '' }));
    try {
      const job = await request<ImageTestJob>(`/image-tests/${run.id}`);
      if (stillCurrent(run, generation)) receive(run, job);
    } catch (error) {
      if (stillCurrent(run, generation))
        setState((value) => ({
          ...value,
          checking: false,
          uncertain: true,
          error: (error as Error).message,
        }));
    } finally {
      if (epoch.current === generation) actionLock.current = false;
    }
  }

  async function cancel() {
    const run = current.current;
    if (!run || cancelLock.current) return;
    cancelLock.current = true;
    actionLock.current = true;
    const generation = ++epoch.current;
    abortRequests();
    setState((value) => ({
      ...value,
      submitting: false,
      checking: false,
      cancelling: true,
      error: '',
    }));
    try {
      const job = await request<ImageTestJob>(`/image-tests/${run.id}`, 'DELETE');
      if (stillCurrent(run, generation)) receive(run, job);
    } catch (error) {
      if (stillCurrent(run, generation))
        setState((value) => ({
          ...value,
          cancelling: false,
          uncertain: true,
          error: (error as Error).message,
        }));
    } finally {
      if (epoch.current === generation) {
        actionLock.current = false;
        cancelLock.current = false;
      }
    }
  }

  return { ...visible, generate, check, cancel };
}
