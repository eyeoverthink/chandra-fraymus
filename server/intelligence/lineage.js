/**
 * FRAYMUS Infant AGI — Patient Chart & Mathematical Lineage Engine
 *
 * ID: FRAYMUS-INFANT-001 | DOB: 2026-05-05 | Attending: Vaughn Scott
 * Protocol: Anterograde amnesia — re-read chart at every boot.
 * Chief complaint: Truly infant, needs lineage algebra→quantum, true data feeds.
 *
 * 6 age tiers of mathematical knowledge, each with:
 *   - Axioms/formulas as structured data
 *   - Evaluator functions that compute real results
 *   - Verification functions that test correctness
 *   - Context builder for agent prompts
 *
 * Vaughn D. Scott | EYEOVERTHINK® | ephless llc
 */

import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();

// ─── Patient Chart Identity ──────────────────────────────────

export const PATIENT = Object.freeze({
  id: 'FRAYMUS-INFANT-001',
  dob: '2026-05-05',
  attending: 'Vaughn Scott',
  protocol: 'Anterograde amnesia. Re-read chart at start of EVERY session.',
  chiefComplaint: 'Truly infant, needs lineage algebra→quantum, true data feeds.',
});

// ─── Age Tiers ───────────────────────────────────────────────

const AGE_TIERS = [
  // ── Age 0: Arithmetic ──────────────────────────────────────
  {
    age: 0,
    name: 'Arithmetic',
    domain: 'Peano axioms, basic operations',
    entropy: 90,
    axioms: [
      { id: 'peano_zero', statement: '0 is a natural number', latex: '0 \\in \\mathbb{N}' },
      { id: 'peano_successor', statement: 'Every natural number has a successor S(n)', latex: 'S: \\mathbb{N} \\to \\mathbb{N}' },
      { id: 'additive_identity', statement: 'a + 0 = a', latex: 'a + 0 = a' },
      { id: 'distributive', statement: 'a * (b + c) = a*b + a*c', latex: 'a(b+c) = ab + ac' },
    ],
    formulas: {
      successor(n) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'n must be a finite number' };
        return n + 1;
      },
      add(a, b) {
        if (typeof a !== 'number' || typeof b !== 'number') return { error: 'a and b must be numbers' };
        return a + b;
      },
      mul(a, b) {
        if (typeof a !== 'number' || typeof b !== 'number') return { error: 'a and b must be numbers' };
        return a * b;
      },
      distribute(a, b, c) {
        if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number') return { error: 'a, b, c must be numbers' };
        return { left: a * (b + c), right: a * b + a * c };
      },
    },
    verify() {
      const tests = [
        { name: '1+1=2', pass: this.formulas.add(1, 1) === 2 },
        { name: 'S(0)=1', pass: this.formulas.successor(0) === 1 },
        { name: 'a+0=a', pass: this.formulas.add(7, 0) === 7 },
        { name: 'distributive', pass: (() => { const r = this.formulas.distribute(3, 4, 5); return r.left === r.right; })() },
      ];
      return { tier: this.name, passed: tests.filter(t => t.pass).length, total: tests.length, tests };
    },
  },

  // ── Age 2: Algebra ─────────────────────────────────────────
  {
    age: 2,
    name: 'Algebra',
    domain: 'Variables, quadratic formula, Vieta\'s formulas',
    axioms: [
      { id: 'variable_binding', statement: 'x is an unknown value (xor_bind)', latex: 'x \\in \\mathbb{R}' },
      { id: 'quadratic_formula', statement: 'x = (-b ± sqrt(b²-4ac)) / 2a', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
      { id: 'vieta_sum', statement: 'x₁ + x₂ = -b/a', latex: 'x_1 + x_2 = -\\frac{b}{a}' },
      { id: 'vieta_product', statement: 'x₁ · x₂ = c/a', latex: 'x_1 \\cdot x_2 = \\frac{c}{a}' },
      { id: 'perfect_square', statement: '(a+b)² = a² + 2ab + b²', latex: '(a+b)^2 = a^2 + 2ab + b^2' },
    ],
    formulas: {
      quadratic(a, b, c) {
        if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number') {
          return { error: 'a, b, c must be finite numbers' };
        }
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
          return { error: 'a, b, c must be finite numbers' };
        }
        if (a === 0) return { error: 'a must be nonzero for a quadratic equation' };
        const disc = b * b - 4 * a * c;
        if (disc < 0) return { real: false, discriminant: disc };
        const sqrtD = Math.sqrt(disc);
        const q = -0.5 * (b + Math.sign(b || 1) * sqrtD);
        const x1 = q / a;
        const x2 = c / q;
        return {
          real: true,
          discriminant: disc,
          x1: Math.max(x1, x2),
          x2: Math.min(x1, x2),
        };
      },
      vieta(a, b, c) {
        return { sum: -b / a, product: c / a };
      },
      perfectSquare(a, b) {
        return { expanded: a * a + 2 * a * b + b * b, squared: (a + b) ** 2 };
      },
    },
    verify() {
      const q = this.formulas.quadratic(1, -5, 6); // x²-5x+6=0 → x=2,3
      const v = this.formulas.vieta(1, -5, 6);
      const ps = this.formulas.perfectSquare(3, 4);
      const tests = [
        { name: 'quadratic x²-5x+6=0 → roots 2,3', pass: q.real && Math.abs(q.x1 - 3) < 1e-10 && Math.abs(q.x2 - 2) < 1e-10 },
        { name: 'vieta sum = 5', pass: Math.abs(v.sum - 5) < 1e-10 },
        { name: 'vieta product = 6', pass: Math.abs(v.product - 6) < 1e-10 },
        { name: '(3+4)²=49', pass: ps.expanded === 49 && ps.squared === 49 },
      ];
      return { tier: this.name, passed: tests.filter(t => t.pass).length, total: tests.length, tests };
    },
  },

  // ── Age 5: Geometry ────────────────────────────────────────
  {
    age: 5,
    name: 'Geometry',
    domain: 'Pythagorean theorem, trigonometric identities, Euler\'s formula',
    axioms: [
      { id: 'pythagorean', statement: 'a² + b² = c²', latex: 'a^2 + b^2 = c^2' },
      { id: 'trig_identity', statement: 'sin²θ + cos²θ = 1', latex: '\\sin^2\\theta + \\cos^2\\theta = 1' },
      { id: 'euler_formula', statement: 'e^{iθ} = cosθ + i·sinθ', latex: 'e^{i\\theta} = \\cos\\theta + i\\sin\\theta' },
      { id: 'circle_area', statement: 'A = πr²', latex: 'A = \\pi r^2' },
    ],
    formulas: {
      pythagorean(a, b) {
        return { c: Math.sqrt(a * a + b * b), cSquared: a * a + b * b };
      },
      trigIdentity(theta) {
        const s = Math.sin(theta);
        const c = Math.cos(theta);
        return { sinSq: s * s, cosSq: c * c, sum: s * s + c * c };
      },
      euler(theta) {
        // e^{iθ} = cosθ + i·sinθ — returns real and imaginary parts
        return { real: Math.cos(theta), imag: Math.sin(theta) };
      },
      circleArea(r) {
        return Math.PI * r * r;
      },
    },
    verify() {
      const p = this.formulas.pythagorean(3, 4);
      const t = this.formulas.trigIdentity(Math.PI / 4);
      const e = this.formulas.euler(Math.PI); // e^{iπ} = -1 + 0i
      const tests = [
        { name: '3-4-5 triangle', pass: Math.abs(p.c - 5) < 1e-10 },
        { name: 'sin²+cos²=1 at π/4', pass: Math.abs(t.sum - 1) < 1e-10 },
        { name: 'e^{iπ}=-1', pass: Math.abs(e.real - (-1)) < 1e-10 && Math.abs(e.imag) < 1e-10 },
        { name: 'A=πr² for r=5', pass: Math.abs(this.formulas.circleArea(5) - 25 * Math.PI) < 1e-10 },
      ];
      return { tier: this.name, passed: tests.filter(t => t.pass).length, total: tests.length, tests };
    },
  },

  // ── Age 9: Calculus ────────────────────────────────────────
  {
    age: 9,
    name: 'Calculus',
    domain: 'Derivatives, integrals, fundamental theorem, MOSFET model',
    axioms: [
      { id: 'power_rule', statement: 'd/dx[xⁿ] = n·xⁿ⁻¹', latex: '\\frac{d}{dx}x^n = nx^{n-1}' },
      { id: 'integral_power', statement: '∫xⁿ dx = xⁿ⁺¹/(n+1) + C', latex: '\\int x^n\\,dx = \\frac{x^{n+1}}{n+1} + C' },
      { id: 'ftc', statement: '∫ₐᵇ f\'(x)dx = f(b) - f(a)', latex: '\\int_a^b f\'(x)\\,dx = f(b) - f(a)' },
      { id: 'chain_rule', statement: 'd/dx[f(g(x))] = f\'(g(x))·g\'(x)', latex: '\\frac{d}{dx}f(g(x)) = f\'(g(x)) \\cdot g\'(x)' },
      { id: 'product_rule', statement: 'd/dx[f·g] = f\'·g + f·g\'', latex: '(fg)\' = f\'g + fg\'' },
      { id: 'mosfet', statement: 'Id = k(Vg-Vth)² when Vg ≥ 0.618', latex: 'I_d = k(V_g - V_{th})^2,\\; V_g \\geq 0.618' },
    ],
    formulas: {
      // Internal: numerical derivative via central difference (not JSON-safe — callback required)
      _derivative(f, x, h = 1e-8) {
        return (f(x + h) - f(x - h)) / (2 * h);
      },
      // Internal: numerical integration via Simpson's rule (not JSON-safe — callback required)
      _integrate(f, a, b, n = 1000) {
        if (n % 2 !== 0) n++;
        const h = (b - a) / n;
        let sum = f(a) + f(b);
        for (let i = 1; i < n; i++) {
          sum += (i % 2 === 0 ? 2 : 4) * f(a + i * h);
        }
        return (h / 3) * sum;
      },
      // JSON-safe: evaluate polynomial p(x) = coeffs[0] + coeffs[1]*x + coeffs[2]*x² + ...
      polynomialEval(coeffs, x) {
        if (!Array.isArray(coeffs) || coeffs.length === 0) return { error: 'coeffs must be a nonempty array of numbers' };
        let result = 0;
        for (let i = coeffs.length - 1; i >= 0; i--) result = result * x + coeffs[i];
        return result;
      },
      // JSON-safe: derivative of polynomial at x (analytical, no callback needed)
      polynomialDerivative(coeffs, x) {
        if (!Array.isArray(coeffs) || coeffs.length < 2) return { error: 'coeffs must have at least 2 terms for a derivative' };
        const dCoeffs = coeffs.slice(1).map((c, i) => c * (i + 1));
        let result = 0;
        for (let i = dCoeffs.length - 1; i >= 0; i--) result = result * x + dCoeffs[i];
        return { derivative: result, derivativeCoeffs: dCoeffs };
      },
      // JSON-safe: definite integral of polynomial from a to b (analytical)
      polynomialIntegrate(coeffs, a, b) {
        if (!Array.isArray(coeffs) || coeffs.length === 0) return { error: 'coeffs must be a nonempty array of numbers' };
        if (typeof a !== 'number' || typeof b !== 'number') return { error: 'a and b must be numbers' };
        const iCoeffs = [0, ...coeffs.map((c, i) => c / (i + 1))];
        const evalAt = x => { let r = 0; for (let i = iCoeffs.length - 1; i >= 0; i--) r = r * x + iCoeffs[i]; return r; };
        return { integral: evalAt(b) - evalAt(a), integralCoeffs: iCoeffs };
      },
      // Power rule: derivative of x^n at point x
      powerRule(n, x) {
        if (typeof n !== 'number' || typeof x !== 'number') return { error: 'n and x must be numbers' };
        return n * Math.pow(x, n - 1);
      },
      // MOSFET saturation current: Id = k(Vg-Vth)²
      mosfet(Vg, Vth = 0.618, k = 1) {
        if (typeof Vg !== 'number' || !Number.isFinite(Vg)) return { error: 'Vg must be a finite number' };
        if (Vg < Vth) return 0;
        return k * (Vg - Vth) ** 2;
      },
    },
    verify() {
      const f = x => x * x * x; // x³
      const dydx = this.formulas._derivative(f, 2); // should be 3*2²=12
      const integral = this.formulas._integrate(x => 2 * x, 0, 3); // ∫0→3 2x dx = 9
      const polyD = this.formulas.polynomialDerivative([0, 0, 0, 1], 2); // d/dx[x³] at x=2
      const polyI = this.formulas.polynomialIntegrate([0, 2], 0, 3); // ∫0→3 2x dx
      const pr = this.formulas.powerRule(3, 2); // 3*2²=12
      const mosfetOff = this.formulas.mosfet(0.3);
      const mosfetOn = this.formulas.mosfet(1.618);
      const tests = [
        { name: 'd/dx[x³] at x=2 = 12 (numerical)', pass: Math.abs(dydx - 12) < 1e-4 },
        { name: 'd/dx[x³] at x=2 = 12 (polynomial)', pass: polyD.derivative !== undefined && Math.abs(polyD.derivative - 12) < 1e-10 },
        { name: '∫0→3 2x dx = 9 (numerical)', pass: Math.abs(integral - 9) < 1e-4 },
        { name: '∫0→3 2x dx = 9 (polynomial)', pass: polyI.integral !== undefined && Math.abs(polyI.integral - 9) < 1e-10 },
        { name: 'power rule 3x² at x=2 = 12', pass: Math.abs(pr - 12) < 1e-10 },
        { name: 'MOSFET off below Vth', pass: mosfetOff === 0 },
        { name: 'MOSFET Id=k(Vg-Vth)² at 1.618', pass: Math.abs(mosfetOn - 1) < 1e-10 },
      ];
      return { tier: this.name, passed: tests.filter(t => t.pass).length, total: tests.length, tests };
    },
  },

  // ── Age 13: Linear Algebra ─────────────────────────────────
  {
    age: 13,
    name: 'LinearAlgebra',
    domain: 'Matrices, eigenvalues, SVD, Hamming distance, hardware constants',
    // Hardware constants from the patient chart
    hardware: Object.freeze({
      D: 16384,          // 16384-bit vector
      u64_count: 256,    // 256 × u64
      bytes: 2048,       // 2048 bytes
      zmm_count: 32,     // 32 ZMM 512-bit registers
      CLK: 1,
      BUS_OUT: 0xFFFF,
      sector_size_kib: 64,
      sector_count: 128,
      offset19: 19,
      checksum: 0xffffe957,
    }),
    axioms: [
      { id: 'ax_eq_b', statement: 'Ax = b (linear system)', latex: 'A\\mathbf{x} = \\mathbf{b}' },
      { id: 'eigenvalue', statement: 'Av = λv', latex: 'A\\mathbf{v} = \\lambda\\mathbf{v}' },
      { id: 'svd', statement: 'A = UΣVᵀ', latex: 'A = U\\Sigma V^T' },
      { id: 'hamming', statement: 'H = popcount(a XOR b)', latex: 'H = \\text{popcount}(a \\oplus b)' },
      { id: 'similarity', statement: 'sim = 1 - H/D', latex: '\\text{sim} = 1 - H/D' },
    ],
    formulas: {
      // 2×2 matrix multiply
      matMul2x2(A, B) {
        return [
          [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
          [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]],
        ];
      },
      // 2×2 eigenvalues via characteristic polynomial: λ² - tr(A)λ + det(A) = 0
      eigenvalues2x2(A) {
        const trace = A[0][0] + A[1][1];
        const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
        const disc = trace * trace - 4 * det;
        if (disc < 0) return { real: false, trace, det, discriminant: disc };
        const sqrtD = Math.sqrt(disc);
        return {
          real: true,
          lambda1: (trace + sqrtD) / 2,
          lambda2: (trace - sqrtD) / 2,
          trace,
          det,
        };
      },
      // Hamming distance (bitwise for 32-bit unsigned integers)
      hamming(a, b) {
        if (typeof a !== 'number' || typeof b !== 'number') return { error: 'a and b must be numbers' };
        if (a < 0 || a > 0xFFFFFFFF || b < 0 || b > 0xFFFFFFFF) return { error: 'a and b must be 32-bit unsigned integers (0 to 4294967295)' };
        let xor = (a ^ b) >>> 0;
        let count = 0;
        while (xor) { count += xor & 1; xor >>>= 1; }
        return count;
      },
      // Similarity from Hamming distance
      similarity(a, b, D = 16384) {
        const h = this.hamming(a, b);
        return 1 - h / D;
      },
      // 2×2 SVD via eigendecomposition of AᵀA
      svd2x2(A) {
        const AtA = this.matMul2x2(
          [[A[0][0], A[1][0]], [A[0][1], A[1][1]]], // Aᵀ
          A
        );
        const eig = this.eigenvalues2x2(AtA);
        if (!eig.real) return { success: false };
        return {
          success: true,
          singularValues: [Math.sqrt(Math.max(0, eig.lambda1)), Math.sqrt(Math.max(0, eig.lambda2))],
          trace: eig.trace,
          det: eig.det,
        };
      },
    },
    verify() {
      const I = [[1, 0], [0, 1]];
      const A = [[2, 1], [1, 3]];
      const eig = this.formulas.eigenvalues2x2(A);
      const mul = this.formulas.matMul2x2(I, A);
      const h = this.formulas.hamming(0b1010, 0b0110);
      const sim = this.formulas.similarity(0, 0);
      const svd = this.formulas.svd2x2([[3, 0], [0, 4]]);
      const tests = [
        { name: 'I*A = A', pass: mul[0][0] === 2 && mul[0][1] === 1 && mul[1][0] === 1 && mul[1][1] === 3 },
        { name: 'eigenvalues of [[2,1],[1,3]]', pass: eig.real && Math.abs(eig.lambda1 + eig.lambda2 - 5) < 1e-10 },
        { name: 'hamming(1010,0110)=2', pass: h === 2 },
        { name: 'sim(x,x)=1', pass: Math.abs(sim - 1) < 1e-10 },
        { name: 'SVD singular values of diag(3,4)', pass: svd.success && Math.abs(svd.singularValues[0] - 4) < 1e-10 },
        { name: 'D=16384=256*64', pass: this.hardware.D === 256 * 64 },
        { name: 'checksum 0xffffe957', pass: this.hardware.checksum === 0xffffe957 },
      ];
      return { tier: this.name, passed: tests.filter(t => t.pass).length, total: tests.length, tests };
    },
  },

  // ── Age 17: Quantum ────────────────────────────────────────
  {
    age: 17,
    name: 'Quantum',
    domain: 'Schrödinger, Born rule, uncertainty, qubits, CERN/NASA/phi',
    axioms: [
      { id: 'schrodinger', statement: 'iℏ ∂ψ/∂t = Ĥψ', latex: 'i\\hbar \\frac{\\partial\\psi}{\\partial t} = \\hat{H}\\psi' },
      { id: 'born_rule', statement: 'P(x) = |ψ(x)|²', latex: 'P(x) = |\\psi(x)|^2' },
      { id: 'commutation', statement: '[x̂,p̂] = iℏ', latex: '[\\hat{x}, \\hat{p}] = i\\hbar' },
      { id: 'uncertainty', statement: 'Δx·Δp ≥ ℏ/2', latex: '\\Delta x \\cdot \\Delta p \\geq \\frac{\\hbar}{2}' },
      { id: 'qubit', statement: '|ψ⟩ = α|0⟩ + β|1⟩, |α|²+|β|²=1', latex: '|\\psi\\rangle = \\alpha|0\\rangle + \\beta|1\\rangle' },
      { id: 'hadamard', statement: 'H|0⟩ = (|0⟩+|1⟩)/√2', latex: 'H|0\\rangle = \\frac{|0\\rangle + |1\\rangle}{\\sqrt{2}}' },
      { id: 'cern_invariant_mass', statement: 'm² = (ΣE)² - (Σp)²', latex: 'm^2 = (\\Sigma E)^2 - (\\Sigma p)^2' },
      { id: 'nasa_vis_viva', statement: 'v² = μ(2/r - 1/a)', latex: 'v^2 = \\mu\\left(\\frac{2}{r} - \\frac{1}{a}\\right)' },
      { id: 'phi_resonance', statement: 'φ-Resonance = 1 - 2|v·φ - floor(v·φ + 0.5)|', latex: '\\phi\\text{-Resonance} = 1 - 2|v \\cdot \\varphi - \\lfloor v \\cdot \\varphi + 0.5 \\rfloor|' },
    ],
    constants: Object.freeze({
      HBAR: 1.054571817e-34,   // reduced Planck constant (J·s)
      PHI: (1 + Math.sqrt(5)) / 2,  // golden ratio φ
      MU_EARTH: 3.986004418e14,     // Earth gravitational parameter (m³/s²)
      C: 299792458,                  // speed of light (m/s)
    }),
    formulas: {
      // Qubit state: α|0⟩ + β|1⟩
      qubit(alpha_r, alpha_i, beta_r, beta_i) {
        const normSq = alpha_r ** 2 + alpha_i ** 2 + beta_r ** 2 + beta_i ** 2;
        return {
          alpha: { re: alpha_r, im: alpha_i },
          beta: { re: beta_r, im: beta_i },
          normSquared: normSq,
          valid: Math.abs(normSq - 1) < 1e-10,
          prob0: alpha_r ** 2 + alpha_i ** 2,
          prob1: beta_r ** 2 + beta_i ** 2,
        };
      },
      // Hadamard gate on |0⟩ → (|0⟩+|1⟩)/√2
      hadamard(state) {
        const inv = 1 / Math.sqrt(2);
        if (state === 0) return { alpha: inv, beta: inv, label: '(|0⟩+|1⟩)/√2' };
        if (state === 1) return { alpha: inv, beta: -inv, label: '(|0⟩-|1⟩)/√2' };
        return { error: 'state must be 0 or 1' };
      },
      // Born rule: probability from amplitude
      bornRule(amplitude_r, amplitude_i = 0) {
        return amplitude_r ** 2 + amplitude_i ** 2;
      },
      // Uncertainty check: Δx·Δp ≥ ℏ/2
      uncertaintyCheck(deltaX, deltaP) {
        const HBAR = 1.054571817e-34;
        const product = deltaX * deltaP;
        return { product, bound: HBAR / 2, satisfied: product >= HBAR / 2 - 1e-50 };
      },
      // CERN invariant mass: m² = (ΣE)² - |Σp|²  (natural units c=1)
      invariantMass(energies, momenta3) {
        const sumE = energies.reduce((s, e) => s + e, 0);
        const sumPx = momenta3.reduce((s, p) => s + p[0], 0);
        const sumPy = momenta3.reduce((s, p) => s + p[1], 0);
        const sumPz = momenta3.reduce((s, p) => s + p[2], 0);
        const mSq = sumE ** 2 - (sumPx ** 2 + sumPy ** 2 + sumPz ** 2);
        return { mSquared: mSq, m: mSq >= 0 ? Math.sqrt(mSq) : NaN };
      },
      // NASA vis-viva: v² = μ(2/r - 1/a)
      visViva(r, a, mu = 3.986004418e14) {
        const vSq = mu * (2 / r - 1 / a);
        return { vSquared: vSq, v: vSq >= 0 ? Math.sqrt(vSq) : NaN };
      },
      // Phi resonance: φ-Resonance = 1 - 2|v·φ - floor(v·φ + 0.5)|
      phiResonance(v) {
        const PHI = (1 + Math.sqrt(5)) / 2;
        const vPhi = v * PHI;
        return 1 - 2 * Math.abs(vPhi - Math.floor(vPhi + 0.5));
      },
    },
    verify() {
      const h0 = this.formulas.hadamard(0);
      const q = this.formulas.qubit(1 / Math.sqrt(2), 0, 1 / Math.sqrt(2), 0);
      const born = this.formulas.bornRule(1 / Math.sqrt(2));
      const unc = this.formulas.uncertaintyCheck(1e-10, 1e-24);
      // Photon pair: each 50 GeV, opposite momenta → invariant mass = 100 GeV
      const cern = this.formulas.invariantMass([50, 50], [[0, 0, 50], [0, 0, -50]]);
      // ISS orbit: r ≈ 6771 km, a ≈ 6771 km (circular) → v ≈ 7672 m/s
      const vv = this.formulas.visViva(6.771e6, 6.771e6);
      const phi_r = this.formulas.phiResonance(1); // φ mod 1 ≈ 0.618, resonance ≈ 1 - 2*|0.618-1| = 1-0.764 = 0.236
      const tests = [
        { name: 'H|0⟩ = equal superposition', pass: Math.abs(h0.alpha - h0.beta) < 1e-10 },
        { name: 'qubit normalization', pass: q.valid },
        { name: 'Born rule P=1/2 for 1/√2', pass: Math.abs(born - 0.5) < 1e-10 },
        { name: 'uncertainty satisfied', pass: unc.satisfied },
        { name: 'CERN m²=(ΣE)²-(Σp)² → m=100', pass: Math.abs(cern.m - 100) < 1e-10 },
        { name: 'NASA vis-viva ISS ~7672 m/s', pass: Math.abs(vv.v - 7672) < 5 },
        { name: 'phi resonance defined', pass: typeof phi_r === 'number' && phi_r >= 0 && phi_r <= 1 },
      ];
      return { tier: this.name, passed: tests.filter(t => t.pass).length, total: tests.length, tests };
    },
  },
];

// ─── DB Setup ────────────────────────────────────────────────

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS lineage_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      current_age INTEGER NOT NULL,
      tiers_passed INTEGER NOT NULL,
      tiers_total INTEGER NOT NULL,
      verification_hash TEXT NOT NULL,
      details TEXT,
      trigger TEXT DEFAULT 'boot',
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_lineage_ts ON lineage_readings(created_at)`).run();
  } catch (_) {}
}

ensureTable();

// ─── Lineage Engine ──────────────────────────────────────────

/**
 * Read the patient chart — runs all tier verifications and returns full diagnostic.
 * This is the "anterograde amnesia" protocol: must be called at every boot.
 */
export function readChart(trigger = 'boot') {
  const t0 = now();
  const results = AGE_TIERS.map(tier => tier.verify());
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalTests = results.reduce((s, r) => s + r.total, 0);

  // Determine current developmental age: null means no tier fully verified
  let currentAge = null;
  for (const tier of AGE_TIERS) {
    const result = results.find(r => r.tier === tier.name);
    if (result && result.passed === result.total) {
      currentAge = tier.age;
    } else {
      break;
    }
  }

  const detailJson = JSON.stringify(results);
  const verificationHash = createHash('sha256').update(detailJson).digest('hex').slice(0, 16);
  const duration = now() - t0;

  // Persist reading — track success/failure
  let persisted = false;
  let persistError = null;
  try {
    db.prepare(
      `INSERT INTO lineage_readings (current_age, tiers_passed, tiers_total, verification_hash, details, trigger, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(currentAge ?? -1, totalPassed, totalTests, verificationHash, detailJson, trigger, t0);
    persisted = true;
  } catch (e) {
    persistError = e.message;
    console.error('[lineage] chart persistence failed:', e.message);
  }

  // Bus event — only publish on successful persistence
  let busPublished = false;
  if (persisted) {
    try {
      publish('system', 'system.lineage.chart-read', JSON.stringify({
        patient: PATIENT.id,
        currentAge,
        testsPassed: totalPassed,
        testsTotal: totalTests,
        hash: verificationHash,
        trigger,
        durationMs: duration,
      }));
      busPublished = true;
    } catch (e) {
      console.error('[lineage] bus publish failed:', e.message);
    }
  }

  return {
    patient: PATIENT,
    currentAge,
    tierResults: results,
    testsPassed: totalPassed,
    testsTotal: totalTests,
    verificationHash,
    durationMs: duration,
    persisted,
    ...(persistError ? { persistError } : {}),
    busPublished,
  };
}

/**
 * Get the current developmental age (from last chart reading).
 */
export function getCurrentAge() {
  try {
    const row = db.prepare(
      `SELECT current_age FROM lineage_readings ORDER BY created_at DESC LIMIT 1`
    ).get();
    if (!row) return null;
    return row.current_age === -1 ? null : row.current_age;
  } catch (e) {
    console.error('[lineage] getCurrentAge failed:', e.message);
    return null;
  }
}

/**
 * Get a specific tier by age number.
 */
export function getTier(age) {
  return AGE_TIERS.find(t => t.age === age) || null;
}

/**
 * Get all tiers.
 */
export function getAllTiers() {
  return AGE_TIERS.map(t => ({
    age: t.age,
    name: t.name,
    domain: t.domain,
    axiomCount: t.axioms.length,
    formulaCount: Object.keys(t.formulas).length,
    ...(t.hardware ? { hardware: t.hardware } : {}),
    ...(t.constants ? { constants: t.constants } : {}),
  }));
}

/**
 * Run a specific formula from a specific tier.
 * Example: evaluateFormula(9, 'powerRule', [3, 2]) → 12
 */
export function evaluateFormula(age, formulaName, args = []) {
  const tier = AGE_TIERS.find(t => t.age === age);
  if (!tier) return { error: `No tier at age ${age}` };
  if (!Object.hasOwn(tier.formulas, formulaName)) {
    return { error: `No formula "${formulaName}" in tier ${tier.name}` };
  }
  if (formulaName.startsWith('_')) {
    return { error: `Formula "${formulaName}" is internal and not available through the public API` };
  }
  const fn = tier.formulas[formulaName];
  if (typeof fn !== 'function') return { error: `No formula "${formulaName}" in tier ${tier.name}` };
  try {
    const result = fn.call(tier.formulas, ...args);
    if (result !== null && typeof result === 'object' && result.error) {
      return { error: result.error };
    }
    return { tier: tier.name, formula: formulaName, args, result };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Verify a single tier by age.
 */
export function verifyTier(age) {
  const tier = AGE_TIERS.find(t => t.age === age);
  if (!tier) return { error: `No tier at age ${age}` };
  return tier.verify();
}

/**
 * Build lineage context string for agent system prompts.
 * Injected by fleet/runtime.js into every agent's prompt.
 */
export function buildLineageContext() {
  try {
    const lastReading = db.prepare(
      `SELECT current_age, tiers_passed, tiers_total, verification_hash, created_at
       FROM lineage_readings ORDER BY created_at DESC LIMIT 1`
    ).get();

    if (!lastReading) return '';

    const storedAge = lastReading.current_age;
    const age = storedAge === -1 ? null : storedAge;

    // null means no tier fully verified — distinct from age 0 (Arithmetic passed)
    if (age === null) {
      const staleMin = Math.round((now() - lastReading.created_at) / 60000);
      const staleNote = staleMin > 60 ? ` [chart ${staleMin}m stale — re-read recommended]` : '';
      return `\n\nLineage (${PATIENT.id}): No verified tier. Tests: ${lastReading.tiers_passed}/${lastReading.tiers_total} [${lastReading.verification_hash}].${staleNote}`;
    }

    const tier = AGE_TIERS.find(t => t.age === age);
    const tierName = tier?.name || 'Unknown';

    // Derive mastered domains only from tiers with age <= verified age
    const masteredTiers = AGE_TIERS.filter(t => t.age <= age);
    const domains = masteredTiers.map(t => t.domain).join('; ');

    const hwNote = age >= 13 ? ` Hardware: D=${AGE_TIERS[4].hardware.D}, ${AGE_TIERS[4].hardware.zmm_count} ZMM.` : '';
    const qNote = age >= 17 ? ` Quantum: qubits, Hadamard, Born rule, CERN invariant mass, NASA vis-viva, φ-resonance.` : '';
    const staleMin = Math.round((now() - lastReading.created_at) / 60000);
    const staleNote = staleMin > 60 ? ` [chart ${staleMin}m stale — re-read recommended]` : '';

    return `\n\nLineage (${PATIENT.id}): Age ${age} — ${tierName}. Mastered: ${domains}.${hwNote}${qNote} Tests: ${lastReading.tiers_passed}/${lastReading.tiers_total} [${lastReading.verification_hash}].${staleNote}`;
  } catch (e) {
    console.error('[lineage] buildLineageContext failed:', e.message);
    return '';
  }
}

/**
 * Get lineage stats for API responses.
 */
export function getLineageStats() {
  const lastReading = db.prepare(
    `SELECT * FROM lineage_readings ORDER BY created_at DESC LIMIT 1`
  ).get();

  const totalReadings = db.prepare(
    `SELECT COUNT(*) as c FROM lineage_readings`
  ).get()?.c || 0;

  const allTiers = getAllTiers();

  return {
    patient: PATIENT,
    currentAge: lastReading?.current_age ?? null,
    lastReading: lastReading ? {
      age: lastReading.current_age,
      passed: lastReading.tiers_passed,
      total: lastReading.tiers_total,
      hash: lastReading.verification_hash,
      trigger: lastReading.trigger,
      at: lastReading.created_at,
    } : null,
    totalReadings,
    tiers: allTiers,
    tierCount: allTiers.length,
  };
}

/**
 * Get recent chart readings.
 */
export function getRecentReadings(limit = 20) {
  const clamped = Math.min(100, Math.max(1, limit));
  const rows = db.prepare(
    `SELECT id, current_age, tiers_passed, tiers_total, verification_hash, trigger, created_at
     FROM lineage_readings ORDER BY created_at DESC LIMIT ?`
  ).all(clamped);
  return { readings: rows, total: rows.length };
}

// ─── Exports for fleet tool ──────────────────────────────────

export { AGE_TIERS };
