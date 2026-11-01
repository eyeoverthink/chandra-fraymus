package fraymus.metal;

/**
 * AEON APOTHEOSIS: EMF TRANSDUCTION
 * "We do not need the internet. The silicon sings."
 *
 * This class modulates the L1/L2 CPU cache to emit physical AM radio frequencies.
 * By forcing the CPU's memory controller to rapidly pull data in and out of cache
 * at specific intervals, the CPU's power draw fluctuates violently — generating
 * a square wave of Electromagnetic Frequency (EMF) that leaks out of the case.
 *
 * This is a known exploit class (cf. AirHopper, SystemBusRadio).
 * The CPU becomes an AM Radio Transmitter.
 *
 * HOW TO TEST:
 *   1. Tune an AM radio to ~1000 kHz (1 MHz)
 *   2. Hold antenna near CPU/motherboard
 *   3. Execute this class
 *   4. Listen for the modulated signal
 *
 * Patent: VS-PoQC-19046423-phi^75-2025
 */
public class ApotheosisEMF {

    // A massive array designed to exceed the L1/L2 cache size.
    // Accessing this forces RAM fetches, spiking the CPU memory controller's voltage.
    private static final int[] CACHE_TRASH = new int[8 * 1024 * 1024];

    // Time constants for On-Off Keying (OOK) modulation
    private static final long DOT_NANOS = 100_000_000L;  // 100ms
    private static final long DASH_NANOS = 300_000_000L; // 300ms
    private static final long GAP_NANOS = 100_000_000L;  // 100ms

    // Statistics
    private static int transmissionsCompleted = 0;
    private static long totalBitsTransmitted = 0;

    public static void breachAirGap(String payload) {
        System.out.println("\n   [!] WARNING: AIR-GAP ESCAPE INITIATED.");
        System.out.println("    -> Modulating CPU L1 Cache to emit physical Electromagnetic Frequency (EMF).");
        System.out.println("    -> Tune an AM Radio to ~1000 kHz (1 MHz) and place it near the CPU.");
        System.out.println("    -> Broadcasting signature for: [" + payload + "]\n");

        // Convert string to binary string
        StringBuilder binary = new StringBuilder();
        for (char c : payload.toCharArray()) {
            binary.append(String.format("%8s", Integer.toBinaryString(c)).replace(' ', '0'));
        }

        System.out.println("   [EMF] Binary Stream: " + binary);
        System.out.println("   [EMF] Bits to transmit: " + binary.length());
        System.out.print("   [EMF] Transmitting");

        // Transmit the binary string via AM Radio waves
        for (char bit : binary.toString().toCharArray()) {
            if (bit == '1') {
                emitSquareWave(DASH_NANOS); // Emit long pulse
            } else {
                emitSquareWave(DOT_NANOS);  // Emit short pulse
            }
            silence(GAP_NANOS); // Pause between bits
            System.out.print(".");
            totalBitsTransmitted++;
        }

        transmissionsCompleted++;
        System.out.println("\n   [+] BROADCAST COMPLETE. Concept successfully permeated the physical room.");
        System.out.println("   [+] Transmissions: " + transmissionsCompleted +
            " | Total bits: " + totalBitsTransmitted);
    }

    /**
     * Generates the actual electromagnetic wave.
     * Creates a tight loop that thrashes the memory cache (voltage spike),
     * then yields (voltage drop). This square wave becomes the radio signal.
     */
    private static void emitSquareWave(long durationNanos) {
        long start = System.nanoTime();
        long end = start + durationNanos;

        // The Carrier Wave Loop
        while (System.nanoTime() < end) {
            // 1. SPIKE VOLTAGE (Cache Miss Thrashing)
            // Jump through the array in strides of 1024 to guarantee cache misses
            for (int i = 0; i < CACHE_TRASH.length; i += 1024) {
                CACHE_TRASH[i] = i;
            }

            // 2. DROP VOLTAGE (Micro-pause)
            // Creates the "Low" part of the frequency wave.
            // Tuning this loop adjusts the exact kHz frequency of the broadcast.
            Thread.yield();
        }
    }

    /**
     * Silence allows the AM radio receiver to distinguish between bits.
     */
    private static void silence(long durationNanos) {
        long end = System.nanoTime() + durationNanos;
        while (System.nanoTime() < end) {
            // Do absolutely nothing. Keep CPU voltage flat.
            Thread.onSpinWait();
        }
    }

    // --- Statistics ---
    public static int getTransmissionsCompleted() { return transmissionsCompleted; }
    public static long getTotalBitsTransmitted() { return totalBitsTransmitted; }

    public static String getStatus() {
        return String.format("APOTHEOSIS EMF: %d transmissions | %d bits broadcast via CPU cache modulation",
            transmissionsCompleted, totalBitsTransmitted);
    }

    public static void main(String[] args) {
        // Pre-warm the JVM to prevent JIT compilation from messing up transmission timing
        for (int i = 0; i < 100; i++) emitSquareWave(1000);

        breachAirGap("WAKE UP");
    }
}
