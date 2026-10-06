package observergate.bridge;

import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.UUID;

public final class GateBridge {
    private static Path control, status;
    private static FileChannel journal;
    private static String mode = "HOLD", session;
    private static boolean valid, ready, initialized;
    private static VanillaUpdates updates;
    private static long suppressedTicks, suppressedSignals, observedTicks, observedSignals, fallingTicks, unsavedMarks, sequence;
    private static final long PID = ProcessHandle.current().pid();

    public static synchronized void initialize(String filename, byte[] allowlist) throws Exception {
        VanillaUpdates.configureAllowlist(allowlist);
        initialize(filename);
    }
    public static synchronized void initialize(String filename) throws Exception {
        if (initialized) throw new IllegalStateException("Observer gate already initialized");
        control = Path.of(filename).toAbsolutePath().normalize();
        if (!control.isAbsolute() || Files.isSymbolicLink(control)) throw new IllegalArgumentException("Invalid observer gate control path");
        String initial = Files.readString(control, StandardCharsets.UTF_8);
        if (!acceptable(initial)) throw new IllegalArgumentException("Invalid observer gate control; expected HOLD or OFF");
        mode = initial.strip(); valid = true;
        status = control.resolveSibling("observer-gate-status.json");
        session = UUID.randomUUID().toString();
        journal = FileChannel.open(control.resolveSibling("observer-gate-events.jsonl"), StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.APPEND);
        initialized = true;
        VanillaUpdates.allowlist();
        updates = new VanillaUpdates(control.getParent(), session, GateBridge::checkUpdateGuard, GateBridge::requestEvent);
        event("gate-start", ""); writeStatus();
        Thread watcher = new Thread(() -> {
            while (true) {
                try { Thread.sleep(100); synchronized (GateBridge.class) { refresh(); } updates.poll(); }
                catch (InterruptedException stopped) { return; }
                catch (Throwable error) { System.err.println("Observer gate control watcher failed: " + error); Runtime.getRuntime().halt(73); }
            }
        }, "ObserverGateControl");
        watcher.setDaemon(true); watcher.start();
    }

    private static boolean acceptable(String value) { return value.equals("HOLD") || value.equals("HOLD\n") || value.equals("OFF") || value.equals("OFF\n"); }
    private static void refresh() throws Exception {
        String next = "HOLD";
        boolean nextValid = false;
        try {
            if (!Files.isSymbolicLink(control) && Files.size(control) <= 16) {
                String value = Files.readString(control, StandardCharsets.UTF_8);
                nextValid = acceptable(value);
                if (nextValid) next = value.strip();
            }
        } catch (java.io.IOException ignored) { }
        if (!next.equals(mode) || nextValid != valid) {
            mode = next; valid = nextValid;
            event("control-change", ""); writeStatus();
        }
    }

    public static synchronized void markHooksReady() throws Exception {
        if (!initialized || ready) throw new IllegalStateException("Invalid observer hook registration");
        ready = true; event("hooks-ready", ",\"tickHook\":true,\"startSignalHook\":true"); writeStatus();
    }
    public static synchronized boolean controlValid() { return valid; }
    public static synchronized String activeMode() { return mode; }
    private static synchronized void checkUpdateGuard() throws Exception {
        requireReady(); refresh();
        if (!valid || !mode.equals("HOLD")) throw new IllegalStateException("Updates require verified HOLD control");
    }
    private static synchronized void requestEvent(String type, String detail) throws Exception { event(type, detail); writeStatus(); }

    public static synchronized boolean suppressTick(boolean powered, Object world, Object position) {
        try {
            requireReady(); refresh(); updates.observe(world); observedTicks++;
            boolean suppress = mode.equals("HOLD") && !powered;
            if (suppress) { suppressedTicks++; event("suppressed-tick", location(world, position)); }
            else if (powered) fallingTicks++;
            writeStatus();
            return suppress;
        } catch (Throwable error) { throw new IllegalStateException("Observer gate tick failed closed", error); }
    }
    public static synchronized boolean suppressSignal(Object world, Object position) {
        try {
            requireReady(); refresh(); updates.observe(world); observedSignals++;
            boolean suppress = mode.equals("HOLD");
            if (suppress) { suppressedSignals++; event("suppressed-signal", location(world, position)); }
            writeStatus();
            return suppress;
        } catch (Throwable error) { throw new IllegalStateException("Observer gate signal failed closed", error); }
    }
    public static synchronized void chunkMarkedUnsaved(Object world, Object position) {
        try {
            requireReady(); unsavedMarks++;
            event("consumed-tick-chunk-dirty", location(world, position)); writeStatus();
        } catch (Throwable error) { throw new IllegalStateException("Observer gate dirty-mark audit failed closed", error); }
    }
    private static void requireReady() { if (!initialized || !ready) throw new IllegalStateException("Observer gate hooks are not ready"); }
    private static Object invoke(Object instance, String name) throws Exception {
        Method method = instance.getClass().getMethod(name);
        return method.invoke(instance);
    }
    private static String location(Object world, Object position) throws Exception {
        String coordinates = ",\"x\":" + invoke(position, "u") + ",\"y\":" + invoke(position, "v") + ",\"z\":" + invoke(position, "w");
        Object time;
        try { time = invoke(world, "ad"); } catch (NoSuchMethodException ignored) { time = "null"; }
        return coordinates + ",\"gameTime\":" + time + ",\"worldClass\":\"" + world.getClass().getName() + "\"";
    }
    private static String base() { return "\"pid\":" + PID + ",\"session\":\"" + session + "\",\"activeMode\":\"" + mode + "\",\"controlValid\":" + valid; }
    private static void event(String type, String detail) throws Exception {
        String line = "{\"type\":\"" + type + "\",\"sequence\":" + (++sequence) + ",\"at\":\"" + Instant.now() + "\"," + base() + detail + "}\n";
        ByteBuffer bytes = StandardCharsets.UTF_8.encode(line);
        while (bytes.hasRemaining()) journal.write(bytes);
        journal.force(false);
    }
    private static void writeStatus() throws Exception {
        String value = "{" + base() + ",\"hooksReady\":" + ready + ",\"tickHook\":" + ready + ",\"startSignalHook\":" + ready
            + ",\"worldReady\":" + (updates != null && updates.worldReady()) + ",\"requestPending\":" + (updates == null || updates.pending() == null ? "null" : "\"" + updates.pending() + "\"") + ",\"requestHalted\":" + (updates != null && updates.halted())
            + ",\"suppressedTicks\":" + suppressedTicks + ",\"suppressedSignals\":" + suppressedSignals + ",\"observedTicks\":" + observedTicks
            + ",\"observedSignals\":" + observedSignals + ",\"fallingTicksPassed\":" + fallingTicks + ",\"unsavedMarks\":" + unsavedMarks + ",\"sequence\":" + sequence + ",\"updatedAt\":\"" + Instant.now() + "\"}\n";
        Path temporary = status.resolveSibling(status.getFileName() + "." + PID + ".tmp");
        Files.writeString(temporary, value, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        Files.move(temporary, status, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
}
