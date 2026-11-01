#!/usr/bin/env python3
"""
Active Brownian Particle (ABP) / Vicsek Model Simulation
Maps noise level vs collective order with full curve analysis.
"""

import numpy as np
import csv
import os
import json
from datetime import datetime

def simulate_abp(N, T, initial_positions, initial_orientations, noise_level, L=10.0):
    """Simulate ABP with reflecting boundaries."""
    positions = initial_positions.copy()
    orientations = initial_orientations.copy()
    polarization_history = []

    for t in range(T):
        # Mean-field alignment
        avg_orientation = np.mean(orientations)

        # Orientation update: alignment + noise
        orientations = avg_orientation + (np.random.rand(N) * 2 - 1) * noise_level

        # Movement
        displacement = np.column_stack([np.cos(orientations), np.sin(orientations)]) * 0.1
        positions += displacement

        # Reflecting boundaries
        for i in range(2):
            mask_out = positions[:, i] > L
            positions[:, i][mask_out] = 2 * L - positions[:, i][mask_out]
            positions[:, i][positions[:, i] < 0] *= -1

        # Polarization M(t)
        M = np.abs(np.mean(np.exp(1j * orientations)))
        polarization_history.append(M)

    return np.array(polarization_history)


def run_noise_curve(N, T, R, noise_levels):
    """Run simulations across noise curve."""
    # Single fixed initial condition for all runs
    np.random.seed(42)
    initial_positions = np.random.rand(N, 2) * 10.0
    initial_orientations = np.random.rand(N) * 2 * np.pi

    results = {f"{eta:.3f}": {"histories": [], "M_avg": None, "M_final": None}
               for eta in noise_levels}

    print(f"ABP Simulation: N={N}, T={T}, R={R}")
    print(f"Noise levels: {len(noise_levels)} points from 0.0 to {noise_levels[-1]:.2f}\n")

    for eta in noise_levels:
        all_M = []
        for r in range(R):
            history = simulate_abp(N, T, initial_positions, initial_orientations, eta)
            all_M.append(history)
            results[f"{eta:.3f}"]["histories"].append(history)

        # Average M across runs
        avg_history = np.mean(all_M, axis=0)
        results[f"{eta:.3f}"]["M_avg"] = float(np.mean(avg_history))
        results[f"{eta:.3f}"]["M_final"] = float(avg_history[-1])

    return results


def analyze_curse(results):
    """Analyze noise vs order relationship."""
    noise = []
    M_avg = []
    M_final = []

    for key, val in results.items():
        eta = float(key)
        noise.append(eta)
        M_avg.append(val["M_avg"])
        M_final.append(val["M_final"])

    noise = np.array(noise)
    M_avg = np.array(M_avg)
    M_final = np.array(M_final)

    # Identify direction changes (local extrema)
    diffs = np.diff(M_avg)
    sign_changes = np.where(np.diff(np.sign(diffs)) != 0)[0] + 1

    # Fit exponential decay (for comparison with ideal model)
    from scipy.optimize import curve_fit
    def exp_decay(eta, a, b):
        return a * np.exp(-b * eta)

    try:
        popt, _ = curve_fit(exp_decay, noise[1:], M_avg[1:], p0=[1.0, 1.0])
        decay_r2 = 1 - np.sum((M_avg[1:] - exp_decay(noise[1:], *popt))**2) / \
                    np.sum((M_avg[1:] - np.mean(M_avg[1:]))**2)
    except:
        popt = None
        decay_r2 = None

    analysis = {
        "N": len(noise),
        "M_baseline": float(M_avg[0]),
        "M_min": float(M_avg[np.argmin(M_avg)]),
        "M_min_eta": float(noise[np.argmin(M_avg)]),
        "M_max": float(M_avg[np.argmax(M_avg)]),
        "M_max_eta": float(noise[np.argmax(M_avg)]),
        "total_drop": float(M_avg[0] - M_avg[-1]),
        "drop_pct": float(100 * (M_avg[0] - M_avg[-1]) / M_avg[0]),
        "local_extrapol_eta": [float(noise[i]) for i in sign_changes],
        "non_monotonic": len(sign_changes) > 0,
        "sign_changes_at": [float(noise[i]) for i in sign_changes],
        "decay_fit": popt.tolist() if popt is not None else None,
        "decay_r2": decay_r2
    }

    return analysis, noise, M_avg, M_final


def main():
    # Parameters
    N = 50        # Particle count
    T = 500       # Time steps
    R = 10        # Repetitions per noise level
    noise_levels = np.arange(0.0, 0.6, 0.02)  # 30 points

    # Run
    results = run_noise_curve(N, T, R, noise_levels)

    # Save raw data to CSV
    base_dir = r"C:\Users\eyeka\Downloads\FRAYNIX-ABP-Experiment"
    results_path = os.path.join(base_dir, "results_noise_curve.csv")

    with open(results_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["noise_level", "M_avg", "M_final", "time_step", "M_t"])
        for key, val in results.items():
            eta = float(key)
            if val["histories"]:
                avg_history = np.mean(val["histories"], axis=0)
                for t, Mt in enumerate(avg_history):
                    writer.writerow([f"{eta:.3f}", f"{val['M_avg']:.4f}",
                                   f"{val['M_final']:.4f}", t, f"{Mt:.4f}"])

    print(f"Raw data saved: {results_path}")

    # Analyze
    analysis, noise, M_avg, M_final = analyze_curse(results)

    # Save analysis
    analysis_path = os.path.join(base_dir, "analysis.json")
    with open(analysis_path, "w") as f:
        json.dump(analysis, f, indent=2)

    print(f"\n=== Analysis ===")
    print(f"Baseline M_avg:       {analysis['M_baseline']:.4f}")
    print(f"Minimum M_avg:        {analysis['M_min']:.4f} at eta={analysis['M_min_eta']:.2f}")
    print(f"Maximum M_avg:        {analysis['M_max']:.4f} at eta={analysis['M_max_eta']:.2f}")
    print(f"Total drop:           {analysis['total_drop']:.4f} ({analysis['drop_pct']:.1f}%)")
    print(f"Non-monotonic:        {analysis['non_monotonic']}")
    if analysis['sign_changes_at']:
        print(f"Sign changes at eta:  {analysis['sign_changes_at']}")
    if analysis['decay_r2'] is not None:
        print(f"Exponential fit R²:   {analysis['decay_r2']:.4f}")
        print(f"Fit params: a={analysis['decay_fit'][0]:.4f}, b={analysis['decay_fit'][1]:.4f}")

    # Save key data for plotting
    curve_path = os.path.join(base_dir, "curve_data.json")
    with open(curve_path, "w") as f:
        json.dump({
            "noise": noise.tolist(),
            "M_avg": M_avg.tolist(),
            "M_final": M_final.tolist()
        }, f)

    return analysis


if __name__ == "__main__":
    main()
