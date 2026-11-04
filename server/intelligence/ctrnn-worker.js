import { parentPort, workerData } from 'node:worker_threads';

const { startIdx, endIdx, dt, tau, B, W, Theta, Iext, gridSize } = workerData;
const N = B.length;
const dtTau = dt / tau;
const newB = new Float64Array(endIdx - startIdx);

for (let i = startIdx; i < endIdx; i++) {
  let sum = 0;
  for (let j = 0; j < N; j++) {
    sum += W[i * N + j] * Math.tanh(B[j] + Theta[j]);
  }
  newB[i - startIdx] = B[i] + dtTau * (-B[i] + sum + Iext[i]);
}

parentPort.postMessage({ startIdx, endIdx, newB: Array.from(newB) });
