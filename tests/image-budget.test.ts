import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_INPUT_TASK_MAX_BYTES,
  ImageInputBudget,
} from '../src/server/runtime/image-budget.js';

test('the default task allowance accepts two 100 MiB images and keeps the exact remaining capacity', () => {
  const budget = new ImageInputBudget();
  const imageBytes = 100 * 1024 * 1024;
  assert.equal(budget.remainingBytes, 256 * 1024 * 1024);
  assert.equal(budget.tryReserve(imageBytes), true);
  assert.equal(budget.tryReserve(imageBytes), true);
  assert.equal(budget.tryReserve(imageBytes), false);
  assert.equal(budget.remainingBytes, 56 * 1024 * 1024);
  assert.equal(budget.tryReserve(budget.remainingBytes), true);
  assert.equal(budget.tryReserve(1), false);
});

test('a live configured allowance changes across pauses without resetting consumed bytes', () => {
  let limit = 32;
  const budget = new ImageInputBudget(() => limit);
  assert.equal(budget.tryReserve(24), true);
  limit = 16;
  assert.equal(budget.remainingBytes, 0);
  assert.equal(budget.tryReserve(1), false);
  limit = 40;
  assert.equal(budget.remainingBytes, 16);
  assert.equal(budget.tryReserve(16), true);
  assert.equal(budget.tryReserve(1), false);
  assert.equal(new ImageInputBudget(40).remainingBytes, 40);
});

test('a declined large image leaves capacity for a smaller explicit read or screenshot', () => {
  const budget = new ImageInputBudget();
  assert.equal(budget.tryReserve(IMAGE_INPUT_TASK_MAX_BYTES - 7), true);
  assert.equal(budget.tryReserve(8), false);
  assert.equal(budget.remainingBytes, 7);
  assert.equal(budget.tryReserve(7), true);
  assert.equal(budget.remainingBytes, 0);
});

test('invalid byte counts never consume or increase a task image allowance', () => {
  const budget = new ImageInputBudget();
  assert.equal(budget.tryReserve(5), true);
  for (const invalid of [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    IMAGE_INPUT_TASK_MAX_BYTES + 1,
  ]) {
    assert.equal(budget.tryReserve(invalid), false, `Must reject ${invalid}`);
    assert.equal(budget.remainingBytes, IMAGE_INPUT_TASK_MAX_BYTES - 5);
  }
});

test('separate task executions have independent image allowances', () => {
  const first = new ImageInputBudget();
  const second = new ImageInputBudget();
  assert.equal(first.tryReserve(IMAGE_INPUT_TASK_MAX_BYTES), true);
  assert.equal(first.remainingBytes, 0);
  assert.equal(second.remainingBytes, IMAGE_INPUT_TASK_MAX_BYTES);
  assert.equal(second.tryReserve(1), true);
  assert.equal(first.remainingBytes, 0);
});
