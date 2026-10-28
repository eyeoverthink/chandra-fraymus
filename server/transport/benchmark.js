import { transportBenchmark } from '../extension-tools.js';
import { vectorBenchmark } from './vectors.js';
console.log(JSON.stringify({ ...transportBenchmark(), vectors: vectorBenchmark() }, null, 2));
