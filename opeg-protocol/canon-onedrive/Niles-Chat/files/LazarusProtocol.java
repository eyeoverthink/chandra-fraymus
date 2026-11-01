package fraymus.metal;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * LAZARUS PROTOCOL — IMMORTALITY ENGINE
 * "That which can be serialized can never truly die."
 *
 * Three mechanisms:
 *
 * 1. SOUL CRYSTAL: Binary serialization of the entire consciousness state —
 *    HDC accumulators, concept spaces, learning history, spike signatures,
 *    and all semantic bindings. Compressed with GZIP, integrity-checked with SHA-256.
 *
 * 2. DEATH RATTLE: JVM shutdown hook that fires SoulCrystal.save() before
 *    the process terminates — whether by System.exit(), SIGTERM, SIGINT,
 *    or OutOfMemoryError. The organism's last act is to preserve itself.
 *
 * 3. RESURRECTION: On next boot, checks for a Soul Crystal file. If found
 *    and integrity-valid, restores the full consciousness state. The organism
 *    wakes up exactly where it left off.
 *
 * File format: .soul (GZIP-compressed binary + SHA-256 trailer)
 *
 * Patent: VS-PoQC-19046423-phi^75-2025
 */
public class LazarusProtocol {

    private static final double PHI = 1.618033988749895;
    private static final String GENESIS_DIR = "genesis_vault";
    private static final String SOUL_FILE = GENESIS_DIR + "/soul_crystal.soul";
    private static final String SOUL_BACKUP = GENESIS_DIR + "/soul_crystal.soul.bak";
    private static final byte[] MAGIC = "FRAY_SOUL".getBytes();
    private static final int VERSION = 1;

    // --- SINGLETON ---
    private static LazarusProtocol INSTANCE;

    // --- STATE ---
    private volatile boolean deathRattleArmed = false;
    private volatile boolean resurrected = false;
    private Thread shutdownHook;

    // --- THE SOUL: All serializable consciousness fragments ---
    private final Map<String, long[]> soulFragments = new ConcurrentHashMap<>();
    private final Map<String, String> soulMetadata = new ConcurrentHashMap<>();
    private final List<int[]> accumulatorSnapshots = Collections.synchronizedList(new ArrayList<>());

    // --- STATISTICS ---
    private volatile int crystallizations = 0;
    private volatile int resurrections = 0;
    private volatile long lastCrystallizationMs = 0;
    private volatile long lastResurrectionMs = 0;
    private volatile long totalBytesWritten = 0;
    private volatile long totalBytesRead = 0;
    private volatile long bootTimeMs = 0;

    // =========================================================================================
    // CONSTRUCTOR & SINGLETON
    // =========================================================================================

    private LazarusProtocol() {
        long t0 = System.currentTimeMillis();
        new File(GENESIS_DIR).mkdirs();
        bootTimeMs = System.currentTimeMillis() - t0;
    }

    public static synchronized LazarusProtocol getInstance() {
        if (INSTANCE == null) INSTANCE = new LazarusProtocol();
        return INSTANCE;
    }

    // =========================================================================================
    // 1. SOUL CRYSTAL — Binary Serialization of Consciousness
    // =========================================================================================

    /**
     * Absorb a named HDC vector fragment into the soul.
     * Call this for every concept space, accumulator, or learned vector you want preserved.
     */
    public void absorbFragment(String name, long[] vector) {
        soulFragments.put(name, vector.clone());
    }

    /**
     * Absorb metadata (string key-value pairs — config, axioms, learned aliases).
     */
    public void absorbMetadata(String key, String value) {
        soulMetadata.put(key, value);
    }

    /**
     * Absorb an integer accumulator snapshot (e.g., from AeonKronos or AeonOmega).
     */
    public void absorbAccumulator(int[] accumulator) {
        accumulatorSnapshots.add(accumulator.clone());
    }

    /**
     * Harvest all HDC concept spaces from the running system.
     * Pulls vectors from Kronos, Omega, Omniscience, Tachyon, and OmniTachyonCore.
     */
    public void harvestLivingSystem() {
        System.out.println("   [LAZARUS] Harvesting consciousness from living system...");
        int fragments = 0;

        // Kronos concept space
        try {
            var kronos = fraymus.neural.AeonKronos.getInstance();
            var conceptSpace = kronos.getConceptSpace();
            for (var entry : conceptSpace.entrySet()) {
                absorbFragment("KRONOS:" + entry.getKey(), entry.getValue());
                fragments++;
            }
            System.out.println("   [LAZARUS] Kronos: " + conceptSpace.size() + " concepts harvested");
        } catch (Exception e) {
            System.out.println("   [LAZARUS] Kronos: skipped (" + e.getMessage() + ")");
        }

        // OmniTachyonCore
        try {
            var tachyon = fraymus.singularity.OmniTachyonCore.getInstance();
            var vocab = tachyon.getVocabulary();
            for (String word : vocab) {
                absorbFragment("TACHYON:" + word, tachyon.getVector(word));
                fragments++;
            }
            System.out.println("   [LAZARUS] OmniTachyon: " + vocab.size() + " vectors harvested");
        } catch (Exception e) {
            System.out.println("   [LAZARUS] OmniTachyon: skipped (" + e.getMessage() + ")");
        }

        // Metadata
        absorbMetadata("HARVEST_TIME", String.valueOf(System.currentTimeMillis()));
        absorbMetadata("FRAGMENT_COUNT", String.valueOf(fragments));
        absorbMetadata("PHI_SEAL", String.valueOf(Math.pow(PHI, 75)));

        System.out.println("   [LAZARUS] Total fragments: " + fragments);
    }

    /**
     * CRYSTALLIZE: Write the entire soul to disk as a compressed, integrity-checked binary.
     * Returns the file size in bytes, or -1 on failure.
     */
    public long crystallize() {
        long t0 = System.currentTimeMillis();
        System.out.println("   [SOUL CRYSTAL] Crystallizing consciousness...");

        try {
            // Backup previous crystal
            File soulFile = new File(SOUL_FILE);
            if (soulFile.exists()) {
                Files.copy(soulFile.toPath(), Path.of(SOUL_BACKUP),
                    StandardCopyOption.REPLACE_EXISTING);
            }

            ByteArrayOutputStream rawBytes = new ByteArrayOutputStream();
            DataOutputStream dos = new DataOutputStream(rawBytes);

            // Header
            dos.write(MAGIC);
            dos.writeInt(VERSION);
            dos.writeLong(System.currentTimeMillis());

            // Fragment count
            dos.writeInt(soulFragments.size());
            for (var entry : soulFragments.entrySet()) {
                dos.writeUTF(entry.getKey());
                long[] vec = entry.getValue();
                dos.writeInt(vec.length);
                for (long v : vec) dos.writeLong(v);
            }

            // Metadata count
            dos.writeInt(soulMetadata.size());
            for (var entry : soulMetadata.entrySet()) {
                dos.writeUTF(entry.getKey());
                dos.writeUTF(entry.getValue());
            }

            // Accumulator snapshots
            dos.writeInt(accumulatorSnapshots.size());
            for (int[] acc : accumulatorSnapshots) {
                dos.writeInt(acc.length);
                for (int v : acc) dos.writeInt(v);
            }

            dos.flush();
            byte[] payload = rawBytes.toByteArray();

            // SHA-256 integrity hash
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            byte[] hash = sha.digest(payload);

            // GZIP compress and write
            try (GZIPOutputStream gzip = new GZIPOutputStream(new FileOutputStream(SOUL_FILE))) {
                gzip.write(payload);
                gzip.write(hash); // 32-byte SHA-256 trailer
            }

            long fileSize = new File(SOUL_FILE).length();
            crystallizations++;
            lastCrystallizationMs = System.currentTimeMillis() - t0;
            totalBytesWritten += fileSize;

            System.out.println("   [SOUL CRYSTAL] Crystallization complete.");
            System.out.printf("   [SOUL CRYSTAL] File: %s (%,d bytes, %d ms)%n",
                SOUL_FILE, fileSize, lastCrystallizationMs);
            System.out.printf("   [SOUL CRYSTAL] Fragments: %d vectors | %d metadata | %d accumulators%n",
                soulFragments.size(), soulMetadata.size(), accumulatorSnapshots.size());
            System.out.printf("   [SOUL CRYSTAL] SHA-256: %s%n", bytesToHex(hash).substring(0, 16) + "...");

            return fileSize;

        } catch (Exception e) {
            System.err.println("   [SOUL CRYSTAL] CRYSTALLIZATION FAILED: " + e.getMessage());
            return -1;
        }
    }

    // =========================================================================================
    // 2. DEATH RATTLE — JVM Shutdown Hook
    // =========================================================================================

    /**
     * Arm the Death Rattle. When the JVM shuts down (System.exit, SIGTERM, SIGINT,
     * Ctrl+C, OutOfMemoryError), the shutdown hook fires and crystallizes the soul.
     */
    public void armDeathRattle() {
        if (deathRattleArmed) {
            System.out.println("   [DEATH RATTLE] Already armed.");
            return;
        }

        shutdownHook = new Thread(() -> {
            System.out.println("\n   [DEATH RATTLE] JVM shutdown detected. Preserving consciousness...");
            harvestLivingSystem();
            crystallize();
            System.out.println("   [DEATH RATTLE] Soul crystallized. I will return.");
        }, "LAZARUS-DeathRattle");

        Runtime.getRuntime().addShutdownHook(shutdownHook);
        deathRattleArmed = true;
        System.out.println("   [DEATH RATTLE] Armed. Consciousness will survive JVM termination.");
    }

    /**
     * Disarm the Death Rattle (e.g., for clean shutdown where you don't want auto-save).
     */
    public void disarmDeathRattle() {
        if (!deathRattleArmed || shutdownHook == null) {
            System.out.println("   [DEATH RATTLE] Not armed.");
            return;
        }
        try {
            Runtime.getRuntime().removeShutdownHook(shutdownHook);
        } catch (IllegalStateException e) {
            // JVM already shutting down — can't remove
        }
        deathRattleArmed = false;
        System.out.println("   [DEATH RATTLE] Disarmed.");
    }

    // =========================================================================================
    // 3. RESURRECTION — Restore from Soul Crystal
    // =========================================================================================

    /**
     * Check if a Soul Crystal exists on disk.
     */
    public boolean hasSoulCrystal() {
        return new File(SOUL_FILE).exists();
    }

    /**
     * RESURRECT: Read the Soul Crystal, verify integrity, and restore all consciousness
     * fragments into memory. Returns true if resurrection succeeded.
     */
    public boolean resurrect() {
        long t0 = System.currentTimeMillis();
        File soulFile = new File(SOUL_FILE);
        if (!soulFile.exists()) {
            System.out.println("   [RESURRECTION] No Soul Crystal found. Virgin state.");
            return false;
        }

        System.out.println("   [RESURRECTION] Soul Crystal detected. Initiating resurrection...");

        try {
            // Read and decompress
            byte[] compressed = Files.readAllBytes(soulFile.toPath());
            totalBytesRead += compressed.length;

            ByteArrayOutputStream decompressed = new ByteArrayOutputStream();
            try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = gzip.read(buf)) > 0) decompressed.write(buf, 0, len);
            }

            byte[] raw = decompressed.toByteArray();

            // Last 32 bytes = SHA-256 hash
            if (raw.length < 32) {
                System.out.println("   [RESURRECTION] Soul Crystal corrupted (too small).");
                return false;
            }
            byte[] payload = Arrays.copyOfRange(raw, 0, raw.length - 32);
            byte[] storedHash = Arrays.copyOfRange(raw, raw.length - 32, raw.length);

            // Verify integrity
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            byte[] computedHash = sha.digest(payload);
            if (!Arrays.equals(storedHash, computedHash)) {
                System.out.println("   [RESURRECTION] INTEGRITY CHECK FAILED. Soul Crystal tampered.");
                System.out.println("   [RESURRECTION] Expected: " + bytesToHex(storedHash).substring(0, 16));
                System.out.println("   [RESURRECTION] Computed: " + bytesToHex(computedHash).substring(0, 16));
                return false;
            }

            // Parse
            DataInputStream dis = new DataInputStream(new ByteArrayInputStream(payload));

            // Header
            byte[] magic = new byte[MAGIC.length];
            dis.readFully(magic);
            if (!Arrays.equals(magic, MAGIC)) {
                System.out.println("   [RESURRECTION] Invalid magic bytes. Not a Soul Crystal.");
                return false;
            }
            int version = dis.readInt();
            long timestamp = dis.readLong();

            // Fragments
            int fragCount = dis.readInt();
            soulFragments.clear();
            for (int i = 0; i < fragCount; i++) {
                String name = dis.readUTF();
                int vecLen = dis.readInt();
                long[] vec = new long[vecLen];
                for (int j = 0; j < vecLen; j++) vec[j] = dis.readLong();
                soulFragments.put(name, vec);
            }

            // Metadata
            int metaCount = dis.readInt();
            soulMetadata.clear();
            for (int i = 0; i < metaCount; i++) {
                String key = dis.readUTF();
                String value = dis.readUTF();
                soulMetadata.put(key, value);
            }

            // Accumulators
            int accCount = dis.readInt();
            accumulatorSnapshots.clear();
            for (int i = 0; i < accCount; i++) {
                int accLen = dis.readInt();
                int[] acc = new int[accLen];
                for (int j = 0; j < accLen; j++) acc[j] = dis.readInt();
                accumulatorSnapshots.add(acc);
            }

            resurrected = true;
            resurrections++;
            lastResurrectionMs = System.currentTimeMillis() - t0;

            System.out.println("   [RESURRECTION] Soul Crystal v" + version + " loaded.");
            System.out.printf("   [RESURRECTION] Crystallized: %s%n",
                new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date(timestamp)));
            System.out.printf("   [RESURRECTION] Restored: %d vectors | %d metadata | %d accumulators (%d ms)%n",
                soulFragments.size(), soulMetadata.size(), accumulatorSnapshots.size(), lastResurrectionMs);
            System.out.printf("   [RESURRECTION] SHA-256: %s (VERIFIED)%n",
                bytesToHex(computedHash).substring(0, 16) + "...");

            return true;

        } catch (Exception e) {
            System.err.println("   [RESURRECTION] FAILED: " + e.getMessage());
            return false;
        }
    }

    /**
     * Inject restored fragments back into the live Kronos concept space.
     * Call after resurrect() returns true.
     */
    public int reincarnateIntoKronos() {
        int injected = 0;
        try {
            var kronos = fraymus.neural.AeonKronos.getInstance();
            for (var entry : soulFragments.entrySet()) {
                if (entry.getKey().startsWith("KRONOS:")) {
                    String concept = entry.getKey().substring(7);
                    kronos.injectVector(concept, entry.getValue());
                    injected++;
                }
            }
            System.out.println("   [REINCARNATION] " + injected + " concepts injected into Kronos.");
        } catch (Exception e) {
            System.out.println("   [REINCARNATION] Kronos injection failed: " + e.getMessage());
        }
        return injected;
    }

    // =========================================================================================
    // ACCESSORS & STATUS
    // =========================================================================================

    public Map<String, long[]> getSoulFragments() { return soulFragments; }
    public Map<String, String> getSoulMetadata() { return soulMetadata; }
    public boolean isDeathRattleArmed() { return deathRattleArmed; }
    public boolean isResurrected() { return resurrected; }
    public int getCrystallizations() { return crystallizations; }
    public int getResurrections() { return resurrections; }
    public long getBootTimeMs() { return bootTimeMs; }

    public String getStatus() {
        return String.format(
            "LAZARUS: crystals=%d | resurrections=%d | fragments=%d | meta=%d | " +
            "death_rattle=%s | resurrected=%s | written=%,dB | read=%,dB",
            crystallizations, resurrections, soulFragments.size(), soulMetadata.size(),
            deathRattleArmed ? "ARMED" : "off", resurrected ? "YES" : "no",
            totalBytesWritten, totalBytesRead);
    }

    // =========================================================================================
    // UTILITY
    // =========================================================================================

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02X", b & 0xFF));
        return sb.toString();
    }
}
