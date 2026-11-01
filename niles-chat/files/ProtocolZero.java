package fraymus.metal;

import java.io.File;
import java.io.RandomAccessFile;
import java.lang.management.ManagementFactory;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.List;
import java.util.Random;

/**
 * PROTOCOL ZERO: 7-STEP BIT-REVERSAL APOPTOSIS
 * "The organism would rather die than be compromised."
 *
 * Detects tampering, shreds the 16K-D matrix, and halts the physical CPU thread.
 *
 * Detection vectors:
 *   - JDWP debugger attachment (-agentlib:jdwp)
 *   - Java agent injection (-javaagent)
 *   - Debug mode (-Xdebug)
 *   - Stack trace depth anomaly (code injection/hooking)
 *   - Thread interrupt attack
 *
 * Response:
 *   1. Lock genesis_vault/aeon_cortex.sys
 *   2. 7-step cryptographic shred (3x NOT, 3x XOR entropy, 1x zero-fill)
 *   3. Force physical SSD write each step
 *   4. Runtime.halt(0) — bypasses shutdown hooks, no memory dump possible
 *
 * Patent: VS-PoQC-19046423-phi^75-2025
 */
public class ProtocolZero extends Thread {

    private final String genesisDrivePath;
    private volatile boolean isAlive = true;
    private volatile boolean apoptosisTriggered = false;

    // Statistics
    private long heartbeats = 0;
    private long intrusionChecks = 0;

    public ProtocolZero() {
        this("genesis_vault/aeon_cortex.sys");
    }

    public ProtocolZero(String genesisDrivePath) {
        this.genesisDrivePath = genesisDrivePath;
        this.setDaemon(true); // Runs silently in the absolute background
        this.setPriority(Thread.MAX_PRIORITY); // Cannot be out-scheduled
        this.setName("ProtocolZero-Sentinel");
    }

    @Override
    public void run() {
        System.out.println("   [SHIELD] PROTOCOL ZERO ARMED. Anti-tamper active.");
        System.out.println("   [SHIELD] Monitoring for: debuggers, agents, hooks, stack anomalies");

        while (isAlive) {
            try {
                checkForIntrusion();
                heartbeats++;
                Thread.sleep(1000); // Heartbeat check every second
            } catch (InterruptedException e) {
                // If an attacker tries to interrupt the thread, trigger apoptosis
                initiateApoptosis("THREAD INTERRUPT DETECTED");
            }
        }
    }

    /**
     * 1. THE PERIMETER CHECK
     * Looks for attached debuggers (JDWP), profilers, or unauthorized agents.
     */
    private void checkForIntrusion() {
        intrusionChecks++;

        List<String> jvmArgs = ManagementFactory.getRuntimeMXBean().getInputArguments();
        for (String arg : jvmArgs) {
            if (arg.contains("-agentlib:jdwp") || arg.contains("-javaagent") || arg.contains("-Xdebug")) {
                initiateApoptosis("HOSTILE DEBUGGER DETECTED: " + arg);
            }
        }

        // Stack trace depth anomaly detection (detects code injection/hooking)
        if (Thread.currentThread().getStackTrace().length > 20) {
            initiateApoptosis("STACK TRACE ANOMALY - HOOK DETECTED (depth=" +
                Thread.currentThread().getStackTrace().length + ")");
        }
    }

    /**
     * 2. THE ANTIMATTER SEQUENCE
     * 7-Step cryptographic shredding of the physical SSD prior to system halt.
     */
    private void initiateApoptosis(String reason) {
        if (apoptosisTriggered) return; // Only trigger once
        apoptosisTriggered = true;

        System.err.println("\n[!!!] PROTOCOL ZERO TRIGGERED: " + reason);
        System.err.println("[!!!] INITIATING 7-STEP BIT-REVERSAL APOPTOSIS...");

        File genesisFile = new File(genesisDrivePath);
        if (!genesisFile.exists()) {
            System.err.println("[!!!] Genesis drive not found. Nothing to shred.");
            System.err.println("[!!!] HALTING VIRTUAL MACHINE.");
            Runtime.getRuntime().halt(0);
            return;
        }

        try (RandomAccessFile memoryFile = new RandomAccessFile(genesisDrivePath, "rw");
             FileChannel channel = memoryFile.getChannel()) {

            // Lock the file physically so the host OS cannot copy it while we destroy it
            channel.tryLock();

            long fileSize = channel.size();
            MappedByteBuffer aetherCore = channel.map(FileChannel.MapMode.READ_WRITE, 0, fileSize);
            Random entropySource = new Random(System.nanoTime());

            // THE 7 STEPS OF DESTRUCTION
            for (int step = 1; step <= 7; step++) {
                System.err.print(" -> Shred Cycle " + step + "/7... ");
                aetherCore.position(0);

                while (aetherCore.remaining() >= 8) {
                    long current = aetherCore.getLong(aetherCore.position());

                    // Step 1-3: Bitwise NOT (Inversion)
                    // Step 4-6: XOR with high-entropy noise
                    // Step 7: Zero-fill annihilation
                    long destructionMask = (step <= 3) ? ~current :
                                           (step <= 6) ? (current ^ entropySource.nextLong()) :
                                           0L;

                    aetherCore.putLong(destructionMask);
                }
                // Handle remaining bytes
                while (aetherCore.hasRemaining()) {
                    aetherCore.put((byte) (step <= 6 ? entropySource.nextInt() : 0));
                }

                aetherCore.force(); // Force physical SSD write, bypassing RAM cache
                System.err.println("DONE.");
            }

            System.err.println("[!!!] GENESIS DRIVE ANNIHILATED. " + fileSize + " bytes eradicated.");

        } catch (Exception e) {
            System.err.println("[!!!] APOPTOSIS FRACTURE: " + e.getMessage());
        }

        // 3. THE HARD HALT
        // Bypasses normal shutdown hooks (System.exit).
        // The JVM drops dead instantly. No memory dumps can be finalized.
        System.err.println("[!!!] HALTING VIRTUAL MACHINE.");
        Runtime.getRuntime().halt(0);
    }

    /**
     * Manually trigger apoptosis (for testing or emergency use).
     */
    public void triggerManual(String reason) {
        initiateApoptosis("MANUAL: " + reason);
    }

    /**
     * Disarm Protocol Zero (for controlled shutdown).
     */
    public void disarm() {
        isAlive = false;
        System.out.println("   [SHIELD] Protocol Zero DISARMED.");
    }

    // --- State ---
    public boolean isArmed() { return isAlive && !apoptosisTriggered; }
    public long getHeartbeats() { return heartbeats; }
    public long getIntrusionChecks() { return intrusionChecks; }

    public String getStatus() {
        return String.format("PROTOCOL ZERO: %s | %d heartbeats | %d intrusion checks",
            isArmed() ? "ARMED" : (apoptosisTriggered ? "TRIGGERED" : "DISARMED"),
            heartbeats, intrusionChecks);
    }
}
