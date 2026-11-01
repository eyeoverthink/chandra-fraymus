import numpy as np

def simulate_abp(N, T, initial_positions, initial_orientations, noise_level):
    """Simulates Active Brownian Particles with identical initial conditions."""
    positions = initial_positions.copy()
    orientations = initial_orientations.copy()
    polarization_history = []

    for t in range(T):
        # Mean field alignment
        avg_orientation = np.mean(orientations)

        # Update orientations: alignment + noise
        orientations = avg_orientation + (np.random.rand(N) * 2 - 1) * noise_level

        # Update positions
        displacement = np.column_stack([np.cos(orientations), np.sin(orientations)]) * 0.1
        positions += displacement

        # Boundary clamping
        positions = np.clip(positions, 0, 10)

        # Polarization M: collective order parameter
        M = np.abs(np.mean(np.cos(orientations)))
        polarization_history.append(M)

    return np.array(polarization_history)


if __name__ == '__main__':
    N = 100
    T = 1000
    R = 10

    # Fixed initial conditions for all runs
    initial_positions = np.random.rand(N, 2) * 10.0
    initial_orientations = np.random.rand(N) * 2 * np.pi

    # Noise levels to test
    noise_levels = [0.0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]

    print("=" * 60)
    print("FRAYNIX ABP PARTICLE COLLISION EXPERIMENT")
    print(f"N={N} particles, T={T} steps, {R} repetitions each")
    print("=" * 60)
    print()
    print(f"{'Noise':>8} | {'Avg M':>8} | {'Min M':>8} | {'Max M':>8} | {'Stdev':>8}")
    print("-" * 60)

    results = {}
    for noise in noise_levels:
        all_M = []
        for r in range(R):
            history = simulate_abp(N, T, initial_positions, initial_orientations, noise)
            all_M.append(np.mean(history))

        avg_M = np.mean(all_M)
        min_M = np.min(all_M)
        max_M = np.max(all_M)
        std_M = np.std(all_M)

        print(f"{noise:8.2f} | {avg_M:8.4f} | {min_M:8.4f} | {max_M:8.4f} | {std_M:8.4f}")
        results[noise] = {"avg": avg_M, "min": min_M, "max": max_M, "std": std_M}

    print()
    print("=" * 60)
    print("OBSERVATION: Noise vs Collective Order")
    print("=" * 60)

    # Detect anomalies (where M increases with noise)
    prev_avg = 0
    for i, noise in enumerate(noise_levels):
        if i > 0 and results[noise]["avg"] > prev_avg * 1.01:
            print(f"  [SURPRISE] M increased at noise={noise:.2f} ({prev_avg:.4f} -> {results[noise]['avg']:.4f})")
        prev_avg = results[noise]["avg"]

    # Overall trend
    first_M = results[noise_levels[0]]["avg"]
    last_M = results[noise_levels[-1]]["avg"]
    print(f"  Start M (noise=0):    {first_M:.4f}")
    print(f"  End M (noise=0.5):    {last_M:.4f}")
    print(f"  Change:               {(last_M - first_M):.4f} ({(last_M - first_M)/first_M*100:+.1f}%)")
    print()
    print("RESULTS written to: results.csv")

    # Write CSV
    with open("results.csv", "w") as f:
        f.write("noise,avg_M,min_M,max_M,std_M\n")
        for noise in noise_levels:
            r = results[noise]
            f.write(f"{noise},{r['avg']:.6f},{r['min']:.6f},{r['max']:.6f},{r['std']:.6f}\n")
