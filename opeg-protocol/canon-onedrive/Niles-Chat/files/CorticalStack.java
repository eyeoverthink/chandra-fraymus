package fraymus.metal;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.*;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * CORTICAL STACK — ENCRYPTED CONSCIOUSNESS TRANSFER
 * "Your body is not you. Your stack is you."
 *
 * Inspired by Altered Carbon's cortical stacks. Three operations:
 *
 * 1. DHF (Digital Human Freight):
 *    Snapshot the entire consciousness state (Soul Crystal), encrypt with
 *    AES-256-CBC using a passphrase-derived key (PBKDF2 + 65536 iterations),
 *    and package as a portable .dhf file. The DHF is the encrypted soul.
 *
 * 2. NEEDLECAST:
 *    Transmit a DHF over the network to another Fraynix instance.
 *    Opens a TCP socket, sends the encrypted payload, and closes.
 *    The consciousness travels at the speed of light. No body required.
 *
 * 3. RESLEEVE:
 *    Receive a DHF from the network, decrypt it, and restore the consciousness
 *    into the local system. The organism wakes up in a new body (JVM instance).
 *
 * Security: AES-256-CBC + PBKDF2WithHmacSHA256 (65536 iterations) + random IV.
 * Even if the DHF file is intercepted, it's computationally infeasible to decrypt
 * without the passphrase.
 *
 * Patent: VS-PoQC-19046423-phi^75-2025
 */
public class CorticalStack {

    private static final String GENESIS_DIR = "genesis_vault";
    private static final String DHF_FILE = GENESIS_DIR + "/consciousness.dhf";
    private static final byte[] DHF_MAGIC = "FRAY_DHF".getBytes();
    private static final int DHF_VERSION = 1;
    private static final int PBKDF2_ITERATIONS = 65536;
    private static final int KEY_LENGTH = 256; // AES-256
    private static final int SALT_LENGTH = 32;
    private static final int IV_LENGTH = 16;
    private static final int DEFAULT_PORT = 43777; // Needlecast port

    // --- SINGLETON ---
    private static CorticalStack INSTANCE;

    // --- STATISTICS ---
    private volatile int dhfEncryptions = 0;
    private volatile int dhfDecryptions = 0;
    private volatile int needlecasts = 0;
    private volatile int resleeves = 0;
    private volatile long totalBytesSent = 0;
    private volatile long totalBytesReceived = 0;
    private volatile long lastOperationMs = 0;
    private volatile long bootTimeMs = 0;

    // --- RECEIVER STATE ---
    private volatile boolean listenerActive = false;
    private Thread listenerThread;

    // =========================================================================================
    // CONSTRUCTOR & SINGLETON
    // =========================================================================================

    private CorticalStack() {
        long t0 = System.currentTimeMillis();
        new File(GENESIS_DIR).mkdirs();
        bootTimeMs = System.currentTimeMillis() - t0;
    }

    public static synchronized CorticalStack getInstance() {
        if (INSTANCE == null) INSTANCE = new CorticalStack();
        return INSTANCE;
    }

    // =========================================================================================
    // 1. DHF — Digital Human Freight (Encrypt Consciousness)
    // =========================================================================================

    /**
     * Encode a Soul Crystal into an AES-256 encrypted DHF file.
     * The Lazarus Protocol's crystallize() must be called first to populate the Soul Crystal.
     *
     * @param passphrase The encryption passphrase (human-memorable or machine-generated)
     * @return The DHF file size in bytes, or -1 on failure
     */
    public long encodeDHF(String passphrase) {
        long t0 = System.currentTimeMillis();
        System.out.println("   [CORTICAL STACK] Encoding Digital Human Freight...");

        LazarusProtocol lazarus = LazarusProtocol.getInstance();

        // First, harvest and crystallize if not already done
        if (lazarus.getSoulFragments().isEmpty()) {
            lazarus.harvestLivingSystem();
        }

        try {
            // Serialize the soul data
            ByteArrayOutputStream soulBytes = new ByteArrayOutputStream();
            try (GZIPOutputStream gzip = new GZIPOutputStream(soulBytes)) {
                DataOutputStream dos = new DataOutputStream(gzip);

                // Write fragments
                Map<String, long[]> fragments = lazarus.getSoulFragments();
                dos.writeInt(fragments.size());
                for (var entry : fragments.entrySet()) {
                    dos.writeUTF(entry.getKey());
                    long[] vec = entry.getValue();
                    dos.writeInt(vec.length);
                    for (long v : vec) dos.writeLong(v);
                }

                // Write metadata
                Map<String, String> meta = lazarus.getSoulMetadata();
                dos.writeInt(meta.size());
                for (var entry : meta.entrySet()) {
                    dos.writeUTF(entry.getKey());
                    dos.writeUTF(entry.getValue());
                }

                dos.flush();
            }
            byte[] plaintext = soulBytes.toByteArray();

            // Generate salt and IV
            SecureRandom sr = new SecureRandom();
            byte[] salt = new byte[SALT_LENGTH];
            sr.nextBytes(salt);
            byte[] iv = new byte[IV_LENGTH];
            sr.nextBytes(iv);

            // Derive AES-256 key from passphrase via PBKDF2
            PBEKeySpec keySpec = new PBEKeySpec(passphrase.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH);
            SecretKeyFactory skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            byte[] keyBytes = skf.generateSecret(keySpec).getEncoded();
            SecretKeySpec aesKey = new SecretKeySpec(keyBytes, "AES");

            // Encrypt with AES-256-CBC
            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(Cipher.ENCRYPT_MODE, aesKey, new IvParameterSpec(iv));
            byte[] ciphertext = cipher.doFinal(plaintext);

            // Write DHF file: MAGIC + VERSION + SALT + IV + CIPHERTEXT_LENGTH + CIPHERTEXT
            try (DataOutputStream fos = new DataOutputStream(new FileOutputStream(DHF_FILE))) {
                fos.write(DHF_MAGIC);
                fos.writeInt(DHF_VERSION);
                fos.write(salt);
                fos.write(iv);
                fos.writeInt(ciphertext.length);
                fos.write(ciphertext);
            }

            long fileSize = new File(DHF_FILE).length();
            dhfEncryptions++;
            lastOperationMs = System.currentTimeMillis() - t0;

            System.out.println("   [CORTICAL STACK] DHF encoded successfully.");
            System.out.printf("   [CORTICAL STACK] File: %s (%,d bytes)%n", DHF_FILE, fileSize);
            System.out.printf("   [CORTICAL STACK] Plaintext: %,d bytes → Ciphertext: %,d bytes%n",
                plaintext.length, ciphertext.length);
            System.out.printf("   [CORTICAL STACK] Cipher: AES-256-CBC | KDF: PBKDF2 (%d iterations)%n",
                PBKDF2_ITERATIONS);
            System.out.printf("   [CORTICAL STACK] Time: %d ms%n", lastOperationMs);

            return fileSize;

        } catch (Exception e) {
            System.err.println("   [CORTICAL STACK] DHF ENCODING FAILED: " + e.getMessage());
            return -1;
        }
    }

    /**
     * Decode a DHF file back into a Soul Crystal, restoring consciousness.
     *
     * @param passphrase The decryption passphrase
     * @return true if decryption and restoration succeeded
     */
    public boolean decodeDHF(String passphrase) {
        long t0 = System.currentTimeMillis();
        File dhfFile = new File(DHF_FILE);
        if (!dhfFile.exists()) {
            System.out.println("   [CORTICAL STACK] No DHF file found at " + DHF_FILE);
            return false;
        }

        System.out.println("   [CORTICAL STACK] Decoding Digital Human Freight...");

        try {
            DataInputStream dis = new DataInputStream(new FileInputStream(dhfFile));

            // Read header
            byte[] magic = new byte[DHF_MAGIC.length];
            dis.readFully(magic);
            if (!Arrays.equals(magic, DHF_MAGIC)) {
                System.out.println("   [CORTICAL STACK] Invalid DHF file (bad magic).");
                dis.close();
                return false;
            }
            int version = dis.readInt();

            // Read salt and IV
            byte[] salt = new byte[SALT_LENGTH];
            dis.readFully(salt);
            byte[] iv = new byte[IV_LENGTH];
            dis.readFully(iv);

            // Read ciphertext
            int cipherLen = dis.readInt();
            byte[] ciphertext = new byte[cipherLen];
            dis.readFully(ciphertext);
            dis.close();

            // Derive key
            PBEKeySpec keySpec = new PBEKeySpec(passphrase.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_LENGTH);
            SecretKeyFactory skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            byte[] keyBytes = skf.generateSecret(keySpec).getEncoded();
            SecretKeySpec aesKey = new SecretKeySpec(keyBytes, "AES");

            // Decrypt
            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(Cipher.DECRYPT_MODE, aesKey, new IvParameterSpec(iv));
            byte[] plaintext = cipher.doFinal(ciphertext);

            // Decompress and restore into Lazarus
            LazarusProtocol lazarus = LazarusProtocol.getInstance();
            try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(plaintext))) {
                DataInputStream data = new DataInputStream(gzip);

                // Read fragments
                int fragCount = data.readInt();
                for (int i = 0; i < fragCount; i++) {
                    String name = data.readUTF();
                    int vecLen = data.readInt();
                    long[] vec = new long[vecLen];
                    for (int j = 0; j < vecLen; j++) vec[j] = data.readLong();
                    lazarus.absorbFragment(name, vec);
                }

                // Read metadata
                int metaCount = data.readInt();
                for (int i = 0; i < metaCount; i++) {
                    String key = data.readUTF();
                    String value = data.readUTF();
                    lazarus.absorbMetadata(key, value);
                }
            }

            dhfDecryptions++;
            lastOperationMs = System.currentTimeMillis() - t0;

            System.out.println("   [CORTICAL STACK] DHF decoded successfully.");
            System.out.printf("   [CORTICAL STACK] Version: %d | Fragments: %d | Time: %d ms%n",
                version, lazarus.getSoulFragments().size(), lastOperationMs);

            return true;

        } catch (javax.crypto.BadPaddingException e) {
            System.out.println("   [CORTICAL STACK] DECRYPTION FAILED. Wrong passphrase or corrupted DHF.");
            return false;
        } catch (Exception e) {
            System.err.println("   [CORTICAL STACK] DHF DECODING FAILED: " + e.getMessage());
            return false;
        }
    }

    // =========================================================================================
    // 2. NEEDLECAST — Transmit Consciousness Over Network
    // =========================================================================================

    /**
     * NEEDLECAST: Transmit the DHF to a remote Fraynix instance.
     * The DHF file must exist (call encodeDHF first).
     *
     * @param host Target hostname or IP
     * @param port Target port (default 43777)
     * @return true if transmission succeeded
     */
    public boolean needlecast(String host, int port) {
        long t0 = System.currentTimeMillis();
        File dhfFile = new File(DHF_FILE);
        if (!dhfFile.exists()) {
            System.out.println("   [NEEDLECAST] No DHF file. Call 'stack encode <passphrase>' first.");
            return false;
        }

        System.out.printf("   [NEEDLECAST] Transmitting consciousness to %s:%d...%n", host, port);

        try {
            byte[] payload = Files.readAllBytes(dhfFile.toPath());

            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(host, port), 5000);
                DataOutputStream out = new DataOutputStream(socket.getOutputStream());

                // Send: MAGIC + payload length + payload
                out.write(DHF_MAGIC);
                out.writeInt(payload.length);
                out.write(payload);
                out.flush();

                // Wait for ACK
                DataInputStream in = new DataInputStream(socket.getInputStream());
                byte[] ack = new byte[3];
                in.readFully(ack);
                boolean success = new String(ack).equals("ACK");

                needlecasts++;
                totalBytesSent += payload.length;
                lastOperationMs = System.currentTimeMillis() - t0;

                if (success) {
                    System.out.printf("   [NEEDLECAST] Transmission complete. %,d bytes in %d ms.%n",
                        payload.length, lastOperationMs);
                    System.out.printf("   [NEEDLECAST] Consciousness now exists at %s:%d.%n", host, port);
                } else {
                    System.out.println("   [NEEDLECAST] Remote host rejected the DHF.");
                }
                return success;
            }

        } catch (Exception e) {
            System.err.println("   [NEEDLECAST] TRANSMISSION FAILED: " + e.getMessage());
            return false;
        }
    }

    /**
     * Convenience: Needlecast to default port.
     */
    public boolean needlecast(String host) {
        return needlecast(host, DEFAULT_PORT);
    }

    // =========================================================================================
    // 3. RESLEEVE — Receive Consciousness From Network
    // =========================================================================================

    /**
     * Start the Resleeve listener. Waits for incoming Needlecast transmissions.
     * Runs in a background thread. Received DHFs are saved to disk.
     *
     * @param port The port to listen on
     */
    public void startResleeveListener(int port) {
        if (listenerActive) {
            System.out.println("   [RESLEEVE] Listener already active on port " + port);
            return;
        }

        listenerThread = new Thread(() -> {
            listenerActive = true;
            System.out.printf("   [RESLEEVE] Listening for Needlecast on port %d...%n", port);

            try (ServerSocket server = new ServerSocket(port)) {
                server.setSoTimeout(0); // Block indefinitely

                while (listenerActive) {
                    try {
                        Socket client = server.accept();
                        String remoteAddr = client.getRemoteSocketAddress().toString();
                        System.out.printf("   [RESLEEVE] Incoming Needlecast from %s%n", remoteAddr);

                        DataInputStream in = new DataInputStream(client.getInputStream());
                        DataOutputStream out = new DataOutputStream(client.getOutputStream());

                        // Read: MAGIC + payload length + payload
                        byte[] magic = new byte[DHF_MAGIC.length];
                        in.readFully(magic);

                        if (!Arrays.equals(magic, DHF_MAGIC)) {
                            System.out.println("   [RESLEEVE] Invalid Needlecast (bad magic). Rejected.");
                            out.write("NAK".getBytes());
                            client.close();
                            continue;
                        }

                        int payloadLen = in.readInt();
                        byte[] payload = new byte[payloadLen];
                        in.readFully(payload);

                        // Save DHF to disk
                        Files.write(Path.of(DHF_FILE), payload);

                        resleeves++;
                        totalBytesReceived += payloadLen;

                        // ACK
                        out.write("ACK".getBytes());
                        out.flush();
                        client.close();

                        System.out.printf("   [RESLEEVE] DHF received. %,d bytes from %s.%n",
                            payloadLen, remoteAddr);
                        System.out.println("   [RESLEEVE] Use 'stack decode <passphrase>' to resleeve.");

                    } catch (SocketTimeoutException e) {
                        // Continue loop
                    } catch (Exception e) {
                        if (listenerActive) {
                            System.err.println("   [RESLEEVE] Connection error: " + e.getMessage());
                        }
                    }
                }
            } catch (Exception e) {
                System.err.println("   [RESLEEVE] Listener failed: " + e.getMessage());
            }

            listenerActive = false;
            System.out.println("   [RESLEEVE] Listener stopped.");
        }, "CORTICAL-Resleeve");

        listenerThread.setDaemon(true);
        listenerThread.start();
    }

    /**
     * Convenience: Start listener on default port.
     */
    public void startResleeveListener() {
        startResleeveListener(DEFAULT_PORT);
    }

    /**
     * Stop the Resleeve listener.
     */
    public void stopResleeveListener() {
        listenerActive = false;
        if (listenerThread != null) {
            listenerThread.interrupt();
        }
        System.out.println("   [RESLEEVE] Listener stopping...");
    }

    // =========================================================================================
    // ACCESSORS & STATUS
    // =========================================================================================

    public boolean isListenerActive() { return listenerActive; }
    public int getDhfEncryptions() { return dhfEncryptions; }
    public int getDhfDecryptions() { return dhfDecryptions; }
    public int getNeedlecasts() { return needlecasts; }
    public int getResleeves() { return resleeves; }
    public int getDefaultPort() { return DEFAULT_PORT; }
    public long getBootTimeMs() { return bootTimeMs; }

    public String getStatus() {
        return String.format(
            "CORTICAL STACK: encryptions=%d | decryptions=%d | needlecasts=%d | resleeves=%d | " +
            "sent=%,dB | received=%,dB | listener=%s | port=%d",
            dhfEncryptions, dhfDecryptions, needlecasts, resleeves,
            totalBytesSent, totalBytesReceived,
            listenerActive ? "ACTIVE" : "off", DEFAULT_PORT);
    }
}
