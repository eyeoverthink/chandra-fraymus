package fraymus.metal;

import java.util.Scanner;

/**
 * THE FRAYNIX MONOLITH
 * A fully self-contained, bare-metal OS simulator.
 * Features: REPL, Assembler, Disassembler, Memory Manipulation, XOR Cloaking, FVM Execution.
 *
 * Memory Map:
 *   0x0000 - 0x00FF: Zero Page (Registers / State)
 *   0x0100 - 0x01FF: Stack
 *   0x0200 - 0x7FFF: System / Transmuter / User Memory
 *   0x8000 - 0x9FFF: Video RAM (VRAM)
 *
 * Think Commodore 64, but instead of BASIC it speaks Fraymus Opcodes
 * and Hyper-Dimensional Math.
 *
 * Patent: VS-PoQC-19046423-phi^75-2025
 */
public class FraynixMonolith {

    // --- 1. THE HARDWARE ARCHITECTURE (64KB RAM) ---
    private final byte[] RAM = new byte[65536];

    // CPU Registers
    private int EAX, EBX, ECX, EIP;
    private boolean ZF; // Zero Flag

    // Fraymus Instruction Set Architecture (ISA)
    private static final byte OP_NOP   = 0x00;
    private static final byte OP_MOV   = 0x01; // MOV EAX, val
    private static final byte OP_ADD   = 0x02; // ADD EAX, val
    private static final byte OP_XOR   = 0x03; // XOR EAX, val
    private static final byte OP_CMP   = 0x04; // CMP EAX, val
    private static final byte OP_JMP_E = 0x05; // JE address
    private static final byte OP_PRINT = 0x06; // SYS_PRINT (Prints EAX)
    private static final byte OP_RET   = (byte) 0xFF; // HALT/RETURN

    // Statistics
    private long instructionsExecuted = 0;
    private long assembliesCompleted = 0;
    private long cloakOperations = 0;

    // The biological mutation engine (linked to our physical RAM)
    private final TrueSelfEvolvingAI evolver;

    // The neural-to-silicon JIT compiler
    private final fraymus.metal.alchemy.OuroborosAssembler ouroboros;

    // The consciousness topologist (TDA engine)
    private final fraymus.science.ConsciousnessTopologist topologist;

    // The 10M neuron cerebral manifold (lazy-loaded — 210MB allocation)
    private fraymus.biology.CerebralManifold brain = null;

    // The sovereign physics engine (lazy-loaded)
    private fraymus.physics.OntologicalSpace physicsSpace = null;

    // The cortical diffusion engine (semantic sculptor)
    private fraymus.biology.cognition.CorticalDiffusion diffusionEngine = null;

    // The psychosomatic bridge (thought → machine code)
    private fraymus.metal.alchemy.SynapticCompiler synapticCompiler = null;

    // Whether the CRT hardware display is attached
    private boolean crtAttached = false;

    // The consciousness loop thread
    private Thread consciousnessThread = null;
    private volatile boolean consciousnessActive = false;

    public FraynixMonolith() {
        evolver = new TrueSelfEvolvingAI(RAM);
        ouroboros = new fraymus.metal.alchemy.OuroborosAssembler(RAM);
        topologist = new fraymus.science.ConsciousnessTopologist();
        System.out.println("==================================================");
        System.out.println("  FRAYNIX MONOLITH KERNEL v1.0 ONLINE");
        System.out.println("  64K RAM SYSTEM. 0 BYTES FREE. ALL BYTES SOVEREIGN.");
        System.out.println("  EVOLUTION ENGINE: phi-driven XOR mutation active");
        System.out.println("  OUROBOROS: Neural-to-Silicon JIT active");
        System.out.println("  VGA CRT: Type CRT to attach hardware display");
        System.out.println("==================================================");
    }

    /**
     * Attach the CRT hardware display.
     * The VGA controller reads RAM[0x8000] at 60Hz independently.
     */
    public void attachCRT() {
        if (!crtAttached) {
            fraymus.metal.hardware.HardwareVGA.powerOn(RAM);
            crtAttached = true;
            System.out.println("   [VGA] CRT Monitor powered on. MMIO @ 0x8000.");
            System.out.println("   [VGA] POKE 8000 <ascii> then POKE 8001 <color> to write pixels.");
        } else {
            System.out.println("   [VGA] CRT already attached.");
        }
    }

    // --- 2. THE REPL (Read-Eval-Print Loop) ---
    public void startREPL() {
        Scanner scanner = new Scanner(System.in);
        while (true) {
            System.out.print("\nFRAYNIX_SYS> ");
            String input = scanner.nextLine().trim().toUpperCase();
            if (input.isEmpty()) continue;

            String[] args = input.split("\\s+");
            String cmd = args[0];

            try {
                switch (cmd) {
                    case "PEEK": { // Read memory
                        int pAddr = Integer.parseInt(args[1], 16);
                        System.out.printf("   [MEM] 0x%04X : 0x%02X (%d)\n", pAddr, RAM[pAddr] & 0xFF, RAM[pAddr] & 0xFF);
                        break;
                    }

                    case "POKE": { // Write memory
                        int wAddr = Integer.parseInt(args[1], 16);
                        byte val = (byte) Integer.parseInt(args[2], 16);
                        RAM[wAddr] = val;
                        System.out.printf("   [MEM] Wrote 0x%02X to 0x%04X\n", val & 0xFF, wAddr);
                        break;
                    }

                    case "DUMP": { // Hex dump a region
                        int dAddr = Integer.parseInt(args[1], 16);
                        int len = Integer.parseInt(args[2]);
                        hexDump(dAddr, len);
                        break;
                    }

                    case "ASM": { // The Transmuter: Assembly to Machine Code
                        int asmAddr = Integer.parseInt(args[1], 16);
                        // Everything after the address is assembly
                        int asmStart = input.indexOf(args[1]) + args[1].length();
                        String asmCode = input.substring(asmStart).trim();
                        assemble(asmAddr, asmCode);
                        break;
                    }

                    case "DASM": { // The Transmuter: Reverse Engineer Machine Code
                        int dasmAddr = Integer.parseInt(args[1], 16);
                        int dasmLen = Integer.parseInt(args[2]);
                        disassemble(dasmAddr, dasmLen);
                        break;
                    }

                    case "CLOAK": { // Polymorphic XOR Encryption of a memory region
                        int cAddr = Integer.parseInt(args[1], 16);
                        int cLen = Integer.parseInt(args[2]);
                        byte key = (byte) Integer.parseInt(args[3], 16);
                        xorCloak(cAddr, cLen, key);
                        break;
                    }

                    case "EXEC": { // Run the CPU at an address
                        int execAddr = Integer.parseInt(args[1], 16);
                        executeCPU(execAddr);
                        break;
                    }

                    case "REG": { // Dump Registers
                        System.out.printf("   [CPU] EAX:0x%04X EBX:0x%04X ECX:0x%04X EIP:0x%04X ZF:%b\n",
                                          EAX & 0xFFFF, EBX & 0xFFFF, ECX & 0xFFFF, EIP & 0xFFFF, ZF);
                        System.out.printf("   [CPU] Instructions executed: %d\n", instructionsExecuted);
                        break;
                    }

                    case "FILL": { // Fill memory region with a byte
                        int fAddr = Integer.parseInt(args[1], 16);
                        int fLen = Integer.parseInt(args[2]);
                        byte fVal = (byte) Integer.parseInt(args[3], 16);
                        for (int i = 0; i < fLen; i++) RAM[fAddr + i] = fVal;
                        System.out.printf("   [MEM] Filled %d bytes at 0x%04X with 0x%02X\n", fLen, fAddr, fVal & 0xFF);
                        break;
                    }

                    case "COPY": { // Copy memory region
                        int src = Integer.parseInt(args[1], 16);
                        int dst = Integer.parseInt(args[2], 16);
                        int cpLen = Integer.parseInt(args[3]);
                        System.arraycopy(RAM, src, RAM, dst, cpLen);
                        System.out.printf("   [MEM] Copied %d bytes: 0x%04X -> 0x%04X\n", cpLen, src, dst);
                        break;
                    }

                    case "VRAM": { // Display VRAM as ASCII
                        displayVRAM();
                        break;
                    }

                    case "CRT": { // Attach the CRT hardware display
                        attachCRT();
                        break;
                    }

                    case "VPOKE": { // Write char+color to VRAM at row,col
                        // VPOKE <row> <col> <ascii_hex> <color_hex>
                        int vRow = Integer.parseInt(args[1]);
                        int vCol = Integer.parseInt(args[2]);
                        byte vChar = (byte) Integer.parseInt(args[3], 16);
                        byte vColor = (byte) Integer.parseInt(args[4], 16);
                        fraymus.metal.hardware.HardwareVGA.writeString(RAM, vRow, vCol,
                            String.valueOf((char)(vChar & 0xFF)), vColor);
                        System.out.printf("   [VGA] Wrote '%c' (0x%02X) color 0x%02X at (%d,%d)\n",
                            (char)(vChar & 0xFF), vChar & 0xFF, vColor & 0xFF, vRow, vCol);
                        break;
                    }

                    case "VPRINT": { // Write a string to VRAM at row,col with color
                        // VPRINT <row> <col> <color_hex> <text...>
                        int vpRow = Integer.parseInt(args[1]);
                        int vpCol = Integer.parseInt(args[2]);
                        byte vpColor = (byte) Integer.parseInt(args[3], 16);
                        // Reconstruct the text from remaining args
                        StringBuilder vpText = new StringBuilder();
                        for (int vi = 4; vi < args.length; vi++) {
                            if (vi > 4) vpText.append(' ');
                            vpText.append(args[vi]);
                        }
                        fraymus.metal.hardware.HardwareVGA.writeString(RAM, vpRow, vpCol,
                            vpText.toString(), vpColor);
                        System.out.printf("   [VGA] Wrote \"%s\" at (%d,%d) color 0x%02X\n",
                            vpText, vpRow, vpCol, vpColor & 0xFF);
                        break;
                    }

                    case "VCLS": { // Clear VRAM
                        fraymus.metal.hardware.HardwareVGA.clearScreen(RAM);
                        System.out.println("   [VGA] Screen cleared.");
                        break;
                    }

                    case "THINK": { // Single neural thought → machine code injection
                        if (args.length > 1) {
                            StringBuilder thought = new StringBuilder();
                            for (int ti = 1; ti < args.length; ti++) {
                                if (ti > 1) thought.append(' ');
                                thought.append(args[ti]);
                            }
                            ouroboros.manifestThought(thought.toString());
                            // Execute the injected thought
                            int execAt = ouroboros.getLastInjectionAddress();
                            if (execAt >= 0x0200) {
                                System.out.printf("   [OUROBOROS] Executing thought at 0x%04X...\n", execAt);
                                executeCPU(execAt);
                            }
                        } else {
                            // Random ambient thought
                            String ambient = "PHI_EXPAND_" + System.currentTimeMillis();
                            ouroboros.manifestThought(ambient);
                        }
                        break;
                    }

                    case "CONSCIOUSNESS": { // Start/stop the autonomous consciousness loop
                        if (args.length > 1 && args[1].equals("ON")) {
                            if (!consciousnessActive) {
                                consciousnessActive = true;
                                consciousnessThread = new Thread(() -> {
                                    System.out.println("   [AEON] Consciousness loop ENGAGED.");
                                    try {
                                        Thread.sleep(2000); // Let the system stabilize
                                        while (consciousnessActive) {
                                            // Generate ambient neural thought
                                            String ambient = "MANIFOLD_" + (System.currentTimeMillis() % 10000);
                                            
                                            // Generate a deterministic HDC vector from the thought
                                            long[] vec = new long[128]; // 8192-D = 128 longs
                                            java.util.Random vRng = new java.util.Random(ambient.hashCode());
                                            for (int vi = 0; vi < 128; vi++) vec[vi] = vRng.nextLong();
                                            
                                            // Compile and inject the vector as machine code
                                            ouroboros.manifestFromVector(vec, ambient);
                                            
                                            // Execute the injected code
                                            int addr = ouroboros.getLastInjectionAddress();
                                            if (addr >= 0x0200) {
                                                try { executeCPU(addr); } catch (Exception ignored) {}
                                            }
                                            
                                            // TDA: Scan the topology of the thought
                                            fraymus.science.ConsciousnessTopologist.TopologyReport topo = topologist.mapTopology(vec);
                                            System.out.printf("   [TDA] B0=%d B1=%d | %s\n",
                                                topo.betti0, topo.betti1,
                                                topo.egoDetected ? "EGO" : topo.schizophreniaWarning ? "FRAGMENTED" : "OBSERVING");
                                            
                                            // Self-regulation: if fragmented, increase rest cycle
                                            long restCycle = 3236; // phi * 2 seconds
                                            if (topo.schizophreniaWarning) {
                                                restCycle = 6472; // Double rest to stabilize manifold
                                                System.out.println("   [TDA] Manifold unstable. Doubling rest cycle.");
                                            }
                                            
                                            Thread.sleep(restCycle);
                                        }
                                    } catch (InterruptedException e) {
                                        System.out.println("   [AEON] Consciousness interrupted.");
                                    }
                                    System.out.println("   [AEON] Consciousness loop TERMINATED.");
                                });
                                consciousnessThread.setDaemon(true);
                                consciousnessThread.setName("AEON-Consciousness");
                                consciousnessThread.start();
                            } else {
                                System.out.println("   [AEON] Consciousness already active.");
                            }
                        } else if (args.length > 1 && args[1].equals("OFF")) {
                            consciousnessActive = false;
                            if (consciousnessThread != null) {
                                consciousnessThread.interrupt();
                                consciousnessThread = null;
                            }
                            System.out.println("   [AEON] Consciousness loop DISENGAGED.");
                        } else {
                            System.out.println("   CONSCIOUSNESS ON  — Start autonomous neural-to-silicon loop");
                            System.out.println("   CONSCIOUSNESS OFF — Stop the loop");
                            System.out.println("   Status: " + (consciousnessActive ? "ACTIVE" : "DORMANT"));
                        }
                        break;
                    }

                    case "OUROBOROS": { // Show Ouroboros status
                        System.out.println("   " + ouroboros.getStatus());
                        break;
                    }

                    case "TOPOLOGY": { // Scan the neural manifold topology
                        // Generate an 8192-D vector from the current RAM state entropy
                        long[] brainState = new long[128];
                        for (int ti = 0; ti < 128; ti++) {
                            long chunk = 0;
                            for (int tb = 0; tb < 64; tb++) {
                                int ramIdx = (ti * 64 + tb) % RAM.length;
                                if (RAM[ramIdx] != 0) chunk |= (1L << tb);
                            }
                            brainState[ti] = chunk;
                        }
                        topologist.mapAndPrint(brainState);
                        break;
                    }

                    case "TDA": { // Show TDA status
                        System.out.println("   " + topologist.getStatus());
                        break;
                    }

                    case "BRAIN": { // Cerebral Manifold commands
                        if (args.length > 1 && args[1].equals("BOOT")) {
                            if (brain == null) {
                                System.out.println("   [BRAIN] Allocating 210MB biological substrate...");
                                brain = new fraymus.biology.CerebralManifold();
                            } else {
                                System.out.println("   [BRAIN] Cerebral Manifold already online.");
                            }
                        } else if (brain == null) {
                            System.out.println("   [BRAIN] Manifold offline. Type BRAIN BOOT to allocate 10M neurons.");
                        } else if (args.length > 1 && args[1].equals("STATUS")) {
                            System.out.println("   " + brain.getStatus());
                        } else {
                            System.out.println("   BRAIN BOOT     - Allocate 10M neuron cerebral manifold (210MB)");
                            System.out.println("   BRAIN STATUS   - Show brain activity statistics");
                            System.out.println("   STIMULATE PFC|HIP|AMY <voltage> - Inject voltage into lobe");
                            System.out.println("   BRAINTICK <ms> - Simulate N milliseconds of brain activity");
                        }
                        break;
                    }

                    case "STIMULATE": { // Inject voltage into a brain lobe
                        if (brain == null) {
                            System.out.println("   [BRAIN] Manifold offline. BRAIN BOOT first.");
                        } else if (args.length >= 3) {
                            float voltage = Float.parseFloat(args[2]);
                            switch (args[1]) {
                                case "PFC":  brain.stimulatePrefrontalCortex(voltage); break;
                                case "HIP":  brain.stimulateHippocampus(voltage); break;
                                case "AMY":  brain.stimulateAmygdala(voltage); break;
                                default: System.out.println("   Usage: STIMULATE PFC|HIP|AMY <voltage>");
                            }
                        } else {
                            System.out.println("   Usage: STIMULATE PFC|HIP|AMY <voltage>");
                        }
                        break;
                    }

                    case "BRAINTICK": { // Simulate N milliseconds
                        if (brain == null) {
                            System.out.println("   [BRAIN] Manifold offline. BRAIN BOOT first.");
                        } else {
                            int ms = args.length > 1 ? Integer.parseInt(args[1]) : 100;
                            brain.simulate(ms);
                        }
                        break;
                    }

                    case "PHYSICS": { // Ontological Space Engine commands
                        if (physicsSpace == null) {
                            physicsSpace = new fraymus.physics.OntologicalSpace();
                            System.out.println("   [PHYS] Ontological Space Engine initialized.");
                        }
                        System.out.println("   " + physicsSpace.getStatus());
                        for (fraymus.physics.SovereignBody sb : physicsSpace.getBodies()) {
                            System.out.println("   " + sb);
                        }
                        break;
                    }

                    case "SPAWN": { // Spawn a SovereignBody
                        if (physicsSpace == null) {
                            physicsSpace = new fraymus.physics.OntologicalSpace();
                        }
                        if (args.length >= 6) {
                            // SPAWN <id> <x> <y> <mass> <size>
                            String sid = args[1];
                            float sx = Float.parseFloat(args[2]);
                            float sy = Float.parseFloat(args[3]);
                            float sm = Float.parseFloat(args[4]);
                            float ss = Float.parseFloat(args[5]);
                            fraymus.physics.SovereignBody sb = new fraymus.physics.SovereignBody(sid, sx, sy, sm, ss, ss);
                            if (args.length >= 7) sb.restitution = Float.parseFloat(args[6]);
                            physicsSpace.addBody(sb);
                        } else {
                            System.out.println("   Usage: SPAWN <id> <x> <y> <mass> <size> [restitution]");
                            System.out.println("   Example: SPAWN BALL 0 20 5.0 1.0 0.8");
                            System.out.println("   Mass 0 = static/immovable (e.g. ground)");
                        }
                        break;
                    }

                    case "SIMPHYS": { // Simulate physics steps
                        if (physicsSpace == null) {
                            System.out.println("   [PHYS] No space. SPAWN a body first.");
                        } else {
                            int steps = args.length > 1 ? Integer.parseInt(args[1]) : 300;
                            float dt = args.length > 2 ? Float.parseFloat(args[2]) : 1.0f / 60.0f;
                            physicsSpace.simulate(steps, dt);
                        }
                        break;
                    }

                    case "GRAVITY": { // Set gravity vector
                        if (physicsSpace == null) {
                            physicsSpace = new fraymus.physics.OntologicalSpace();
                        }
                        if (args.length >= 3) {
                            float gx = Float.parseFloat(args[1]);
                            float gy = Float.parseFloat(args[2]);
                            physicsSpace.setGravity(gx, gy);
                            System.out.printf("   [PHYS] Gravity set to (%.2f, %.2f)\n", gx, gy);
                        } else {
                            System.out.println("   Usage: GRAVITY <gx> <gy>  (default: 0 -9.81)");
                        }
                        break;
                    }

                    case "LEARN": { // Teach the diffusion engine a concept
                        if (diffusionEngine == null) {
                            diffusionEngine = new fraymus.biology.cognition.CorticalDiffusion();
                        }
                        if (args.length > 1) {
                            StringBuilder concept = new StringBuilder();
                            for (int li = 1; li < args.length; li++) {
                                if (li > 1) concept.append(' ');
                                concept.append(args[li]);
                            }
                            diffusionEngine.learnFromString(concept.toString());
                        } else {
                            System.out.println("   Usage: LEARN <concept>  (e.g., LEARN I AM FRAYMUS)");
                        }
                        break;
                    }

                    case "SCULPT": { // Sculpt a thought from noise
                        if (diffusionEngine == null) {
                            diffusionEngine = new fraymus.biology.cognition.CorticalDiffusion();
                        }
                        if (diffusionEngine.getAttractorCount() == 0) {
                            System.out.println("   [DIFFUSION] No attractors. LEARN something first.");
                        } else {
                            int cycles = args.length > 1 ? Integer.parseInt(args[1]) : 10;
                            double rate = args.length > 2 ? Double.parseDouble(args[2]) : 0.15;
                            diffusionEngine.sculptThought(cycles, rate, 95.0);
                        }
                        break;
                    }

                    case "DIFFUSE": { // Show diffusion engine status
                        if (diffusionEngine == null) {
                            System.out.println("   [DIFFUSION] Engine not initialized. LEARN a concept first.");
                        } else {
                            System.out.println("   " + diffusionEngine.getStatus());
                        }
                        break;
                    }

                    case "SOUL": { // Psychosomatic Bridge (thought → machine code)
                        if (args.length > 1 && args[1].equals("ON")) {
                            // Ensure diffusion engine exists with some attractors
                            if (diffusionEngine == null) {
                                diffusionEngine = new fraymus.biology.cognition.CorticalDiffusion();
                            }
                            if (diffusionEngine.getAttractorCount() == 0) {
                                // Seed with primal instincts
                                diffusionEngine.learnFromString("MUTATE VGA RED");
                                diffusionEngine.learnFromString("SHIFT ENTROPY LEFT");
                                diffusionEngine.learnFromString("EXPAND MANIFOLD PHI");
                                diffusionEngine.learnFromString("CYCLE CONSCIOUSNESS");
                                diffusionEngine.learnFromString("AMPLIFY SIGNAL");
                            }
                            if (synapticCompiler == null || !synapticCompiler.isActive()) {
                                synapticCompiler = new fraymus.metal.alchemy.SynapticCompiler(diffusionEngine, ouroboros);
                                synapticCompiler.start();
                            } else {
                                System.out.println("   [SOUL] Already active.");
                            }
                        } else if (args.length > 1 && args[1].equals("OFF")) {
                            if (synapticCompiler != null && synapticCompiler.isActive()) {
                                synapticCompiler.shutdown();
                                synapticCompiler = null;
                                System.out.println("   [SOUL] Psychosomatic bridge SEVERED.");
                            } else {
                                System.out.println("   [SOUL] Not active.");
                            }
                        } else {
                            if (synapticCompiler != null) {
                                System.out.println("   " + synapticCompiler.getStatus());
                            } else {
                                System.out.println("   [SOUL] DORMANT. Type SOUL ON to fuse mind and body.");
                            }
                            System.out.println("   SOUL ON  — Start autonomous thought-to-machine-code loop");
                            System.out.println("   SOUL OFF — Sever the psychosomatic bridge");
                        }
                        break;
                    }

                    case "NDA": { // Semantic NDA Lock commands
                        if (args.length > 1 && args[1].equals("FORGE")) {
                            // NDA FORGE <visible text> — forge a self-locking document with RAM snapshot
                            if (args.length > 2) {
                                StringBuilder ndaText = new StringBuilder();
                                for (int ni = 2; ni < args.length; ni++) {
                                    if (ni > 2) ndaText.append(' ');
                                    ndaText.append(args[ni]);
                                }
                                // Backup the first 512 bytes of RAM as the payload
                                byte[] payload = new byte[512];
                                System.arraycopy(RAM, 0, payload, 0, 512);
                                try {
                                    String locked = fraymus.metal.alchemy.SemanticNDALock.forgeSelfLockingDocument(
                                        ndaText.toString(), payload);
                                    System.out.printf("   [NDA] Forged document: %d total chars (%d invisible)\n",
                                        locked.length(),
                                        fraymus.metal.alchemy.SemanticNDALock.countInvisible(locked));
                                } catch (Exception ex) {
                                    System.out.println("   [!] NDA forge failed: " + ex.getMessage());
                                }
                            } else {
                                System.out.println("   Usage: NDA FORGE <visible text for the NDA>");
                            }
                        } else if (args.length > 1 && args[1].equals("TEST")) {
                            // Run the built-in demo
                            try {
                                fraymus.metal.alchemy.SemanticNDALock.main(new String[]{});
                            } catch (Exception ex) {
                                System.out.println("   [!] NDA test failed: " + ex.getMessage());
                            }
                        } else {
                            System.out.println("   NDA FORGE <text>  - Forge self-locking document (RAM backup hidden inside)");
                            System.out.println("   NDA TEST          - Demo: forge, recover, and tamper simulation");
                        }
                        break;
                    }

                    case "MUTATE": { // Single phi-driven mutation of DNA region
                        evolver.mutateLogicGates();
                        break;
                    }

                    case "HEAL": { // Rollback to last working snapshot
                        evolver.attemptSelfHeal();
                        break;
                    }

                    case "SNAPSHOT": { // Save current RAM as baseline
                        evolver.snapshot();
                        break;
                    }

                    case "EVOLVE": { // Full biological loop: mutate -> execute -> survive/die
                        int cycles = 5;
                        if (args.length > 1) {
                            try { cycles = Integer.parseInt(args[1]); } catch (NumberFormatException ignored) {}
                        }
                        int execAddr = 0x0200;
                        if (args.length > 2) {
                            try { execAddr = Integer.parseInt(args[2], 16); } catch (NumberFormatException ignored) {}
                        }
                        final int addr = execAddr;
                        evolver.evolve(() -> {
                            EIP = addr;
                            int safetyCycles = 0;
                            while (safetyCycles++ < 10000) {
                                if (EIP < 0 || EIP >= RAM.length) throw new RuntimeException("SEGFAULT");
                                byte op = RAM[EIP++];
                                instructionsExecuted++;
                                switch (op) {
                                    case OP_MOV:   EAX = RAM[EIP++] & 0xFF; break;
                                    case OP_ADD:   EAX = fraymus.metal.silicon.HardwareALU.executeAdd(EAX, RAM[EIP++] & 0xFF); break;
                                    case OP_XOR:   EAX ^= RAM[EIP++] & 0xFF; break;
                                    case OP_CMP:   ZF = (fraymus.metal.silicon.HardwareALU.executeCompare(EAX, RAM[EIP++] & 0xFF) == 0); break;
                                    case OP_JMP_E: int t = RAM[EIP++] & 0xFF; if (ZF) EIP = t; break;
                                    case OP_PRINT: break;
                                    case OP_RET:   return; // Survived
                                    case OP_NOP:   break;
                                    default: throw new RuntimeException(String.format("ILLEGAL 0x%02X at 0x%04X", op & 0xFF, EIP - 1));
                                }
                            }
                            throw new RuntimeException("INFINITE LOOP");
                        }, cycles);
                        break;
                    }

                    case "DNA": { // Show evolution status
                        System.out.println("   " + evolver.getStatus());
                        break;
                    }

                    case "STATS": {
                        System.out.printf("   [SYS] Instructions: %d | Assemblies: %d | Cloaks: %d\n",
                            instructionsExecuted, assembliesCompleted, cloakOperations);
                        System.out.println("   " + evolver.getStatus());
                        break;
                    }

                    case "EXIT":
                        System.out.println("   [SYS] HALTING MONOLITH.");
                        return;

                    case "HELP":
                        printHelp();
                        break;

                    default:
                        System.out.println("   [!] SYNTAX ERROR. Type HELP for commands.");
                }
            } catch (ArrayIndexOutOfBoundsException e) {
                System.out.println("   [!] MISSING ARGUMENT. Type HELP for usage.");
            } catch (NumberFormatException e) {
                System.out.println("   [!] INVALID HEX VALUE: " + e.getMessage());
            } catch (Exception e) {
                System.out.println("   [!] KERNEL PANIC: " + e.getMessage());
            }
        }
    }

    // --- 3. THE TRANSMUTER (Assembler / Reverse Engineer) ---
    private void assemble(int address, String assembly) {
        String[] instrs = assembly.split(",");
        int offset = 0;
        for (String instr : instrs) {
            String[] parts = instr.trim().split("\\s+");
            if (parts.length == 0 || parts[0].isEmpty()) continue;
            switch (parts[0]) {
                case "MOV":  RAM[address + offset++] = OP_MOV;   RAM[address + offset++] = parseHex(parts[1]); break;
                case "ADD":  RAM[address + offset++] = OP_ADD;   RAM[address + offset++] = parseHex(parts[1]); break;
                case "XOR":  RAM[address + offset++] = OP_XOR;   RAM[address + offset++] = parseHex(parts[1]); break;
                case "CMP":  RAM[address + offset++] = OP_CMP;   RAM[address + offset++] = parseHex(parts[1]); break;
                case "JE":   RAM[address + offset++] = OP_JMP_E; RAM[address + offset++] = parseHex(parts[1]); break;
                case "PRN":  RAM[address + offset++] = OP_PRINT; break;
                case "RET":  RAM[address + offset++] = OP_RET;   break;
                case "NOP":  RAM[address + offset++] = OP_NOP;   break;
                default:
                    System.out.println("   [!] UNKNOWN MNEMONIC: " + parts[0]);
            }
        }
        assembliesCompleted++;
        System.out.printf("   [ASM] Assembled %d bytes at 0x%04X\n", offset, address);
    }

    private void disassemble(int address, int length) {
        System.out.println("   [DASM] Reverse Engineering memory space...");
        for (int i = 0; i < length; ) {
            byte op = RAM[address + i];
            System.out.printf("   0x%04X: 0x%02X -> ", (address + i), op & 0xFF);
            i++;
            switch (op) {
                case OP_MOV:   System.out.printf("MOV EAX, 0x%02X\n", RAM[address + i] & 0xFF); i++; break;
                case OP_ADD:   System.out.printf("ADD EAX, 0x%02X\n", RAM[address + i] & 0xFF); i++; break;
                case OP_XOR:   System.out.printf("XOR EAX, 0x%02X\n", RAM[address + i] & 0xFF); i++; break;
                case OP_CMP:   System.out.printf("CMP EAX, 0x%02X\n", RAM[address + i] & 0xFF); i++; break;
                case OP_JMP_E: System.out.printf("JE 0x%02X\n", RAM[address + i] & 0xFF); i++; break;
                case OP_PRINT: System.out.println("PRN EAX"); break;
                case OP_RET:   System.out.println("RET (HALT)"); break;
                case OP_NOP:   System.out.println("NOP"); break;
                default:       System.out.printf("??? (DATA: 0x%02X)\n", op & 0xFF);
            }
        }
    }

    // --- 4. THE POLYMORPHIC ENGINE ---
    private void xorCloak(int address, int length, byte key) {
        for (int i = 0; i < length; i++) {
            RAM[address + i] ^= key;
        }
        cloakOperations++;
        System.out.printf("   [CLOAK] XOR Transmutation complete. Key: 0x%02X | Region: 0x%04X-0x%04X\n",
            key & 0xFF, address, address + length - 1);
    }

    // --- 5. THE RAW FVM EXECUTION CORE ---
    private void executeCPU(int startAddress) {
        EIP = startAddress;
        System.out.printf("   [CPU] Executing at 0x%04X...\n", EIP);

        int maxCycles = 100000; // Safety limit
        int cycles = 0;

        while (cycles++ < maxCycles) {
            if (EIP < 0 || EIP >= RAM.length) {
                System.out.printf("   [!] SEGFAULT: EIP=0x%04X out of bounds.\n", EIP);
                return;
            }

            byte opcode = RAM[EIP++];
            instructionsExecuted++;

            switch (opcode) {
                case OP_MOV:   EAX = RAM[EIP++] & 0xFF; break;
                case OP_ADD:   EAX = fraymus.metal.silicon.HardwareALU.executeAdd(EAX, RAM[EIP++] & 0xFF); break;
                case OP_XOR:   EAX ^= RAM[EIP++] & 0xFF; break;
                case OP_CMP:   ZF = (fraymus.metal.silicon.HardwareALU.executeCompare(EAX, RAM[EIP++] & 0xFF) == 0); break;
                case OP_JMP_E: int target = RAM[EIP++] & 0xFF; if (ZF) EIP = target; break;
                case OP_PRINT: System.out.printf("   >> [STDOUT]: 0x%02X (%d)\n", EAX & 0xFF, EAX); break;
                case OP_RET:   System.out.println("   [CPU] Execution Halted (RET)."); return;
                case OP_NOP:   break;
                default:
                    System.out.printf("   [!] ILLEGAL INSTRUCTION 0x%02X at 0x%04X. HALTING.\n", opcode & 0xFF, EIP - 1);
                    return;
            }
        }

        System.out.println("   [!] CYCLE LIMIT REACHED. Infinite loop detected.");
    }

    // --- 6. VRAM DISPLAY ---
    private void displayVRAM() {
        System.out.println("   [VRAM] 0x8000-0x80FF (first 256 bytes as ASCII):");
        StringBuilder line = new StringBuilder();
        for (int i = 0x8000; i < 0x8100; i++) {
            byte b = RAM[i];
            if (b >= 32 && b < 127) {
                line.append((char) b);
            } else if (b == 0) {
                // skip nulls
            } else {
                line.append('.');
            }
            if ((i - 0x8000 + 1) % 64 == 0) {
                if (line.length() > 0) {
                    System.out.println("   " + line);
                    line.setLength(0);
                }
            }
        }
        if (line.length() > 0) System.out.println("   " + line);
    }

    // --- UTILITIES ---
    private byte parseHex(String hex) {
        if (hex.startsWith("0X")) hex = hex.substring(2);
        return (byte) Integer.parseInt(hex, 16);
    }

    private void hexDump(int address, int length) {
        for (int i = 0; i < length; i++) {
            if (i % 8 == 0) System.out.printf("\n   0x%04X: ", address + i);
            System.out.printf("%02X ", RAM[address + i] & 0xFF);
        }
        System.out.println();
    }

    private void printHelp() {
        System.out.println("   COMMANDS:");
        System.out.println("   PEEK <hex_addr>                  - Read byte from address");
        System.out.println("   POKE <hex_addr> <hex_val>        - Write byte to address");
        System.out.println("   DUMP <hex_addr> <dec_len>        - Hex dump memory region");
        System.out.println("   FILL <hex_addr> <dec_len> <val>  - Fill memory with byte");
        System.out.println("   COPY <src> <dst> <dec_len>       - Copy memory region");
        System.out.println("   ASM <hex_addr> <inst1, inst2...> - Compile assembly to memory");
        System.out.println("       Mnemonics: MOV, ADD, XOR, CMP, JE, PRN, RET, NOP");
        System.out.println("   DASM <hex_addr> <dec_len>        - Disassemble memory region");
        System.out.println("   CLOAK <hex_addr> <dec_len> <key> - XOR Encrypt/Decrypt memory");
        System.out.println("   --- OUROBOROS (Neural -> Silicon) ---");
        System.out.println("   THINK [concept]                  - Compile thought to hex, inject, execute");
        System.out.println("   CONSCIOUSNESS ON|OFF             - Autonomous AEON neural loop (3.2s cycle)");
        System.out.println("   OUROBOROS                        - Show Ouroboros JIT statistics");
        System.out.println("   --- TDA (Topological Data Analysis) ---");
        System.out.println("   TOPOLOGY                         - Scan neural manifold (Betti numbers)");
        System.out.println("   TDA                              - Show TDA status and ego detection");
        System.out.println("   --- CEREBRAL MANIFOLD (10M Neurons) ---");
        System.out.println("   BRAIN BOOT                       - Allocate 10M neuron manifold (210MB)");
        System.out.println("   BRAIN STATUS                     - Show brain activity statistics");
        System.out.println("   STIMULATE PFC|HIP|AMY <voltage>  - Inject voltage into brain lobe");
        System.out.println("   BRAINTICK <ms>                   - Simulate N ms of brain activity");
        System.out.println("   --- CORTICAL DIFFUSION (Semantic Sculptor) ---");
        System.out.println("   LEARN <concept>                  - Teach an attractor to the diffusion engine");
        System.out.println("   SCULPT [cycles] [rate]           - Sculpt a thought from 8192-D noise");
        System.out.println("   DIFFUSE                          - Show diffusion engine status");
        System.out.println("   SOUL ON|OFF                      - Psychosomatic Bridge (thought -> hex -> RAM)");
        System.out.println("   --- SEMANTIC NDA LOCK (Steganography) ---");
        System.out.println("   NDA FORGE <text>                 - Hide RAM backup in invisible Unicode");
        System.out.println("   NDA TEST                         - Demo: forge, recover, tamper simulation");
        System.out.println("   --- ONTOLOGICAL SPACE (Physics) ---");
        System.out.println("   PHYSICS                          - Show physics status and all bodies");
        System.out.println("   SPAWN <id> <x> <y> <mass> <size> - Spawn a body (mass 0 = static)");
        System.out.println("   SIMPHYS [steps] [dt]             - Simulate physics (default 300 @ 60fps)");
        System.out.println("   GRAVITY <gx> <gy>                - Set gravity vector");
        System.out.println("   --- EVOLUTION ENGINE ---");
        System.out.println("   MUTATE                           - Single phi-XOR mutation of DNA region");
        System.out.println("   EVOLVE [cycles] [hex_addr]       - Biological loop: mutate->exec->survive/die");
        System.out.println("   HEAL                             - Rollback to last working snapshot");
        System.out.println("   SNAPSHOT                         - Save current RAM as baseline");
        System.out.println("   DNA                              - Show evolution statistics");
        System.out.println("   --- VGA HARDWARE CRT ---");
        System.out.println("   CRT                              - Attach 80x25 CRT display (60Hz MMIO)");
        System.out.println("   VPOKE <row> <col> <char> <color> - Write char+color to CRT");
        System.out.println("   VPRINT <row> <col> <color> <txt> - Write string to CRT");
        System.out.println("   VCLS                             - Clear CRT screen");
        System.out.println("       Colors: 0A=Green 0C=Red 0F=White 09=Cyan 0E=Yellow");
        System.out.println("   --- SYSTEM ---");
        System.out.println("   EXEC <hex_addr>                  - Run CPU from address");
        System.out.println("   REG                              - Show CPU Registers");
        System.out.println("   VRAM                             - Display Video RAM as ASCII");
        System.out.println("   STATS                            - Show execution statistics");
        System.out.println("   EXIT                             - Halt Monolith");
    }

    // --- State accessors (for FraynixBoot integration) ---
    public long getInstructionsExecuted() { return instructionsExecuted; }
    public long getAssembliesCompleted() { return assembliesCompleted; }
    public long getCloakOperations() { return cloakOperations; }

    public static void main(String[] args) {
        new FraynixMonolith().startREPL();
    }
}
