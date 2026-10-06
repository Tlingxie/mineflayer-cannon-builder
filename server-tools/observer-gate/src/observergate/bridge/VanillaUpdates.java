package observergate.bridge;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.Executor;

public final class VanillaUpdates {
    public static final String SOURCE_SHA256 = "8c2d8bf4dc8059cb083a28368da2efa1be2bd2dd4999d8b8062d115c4c758632";
    public static final String ALLOWLIST_SHA256 = "cfab00df298d498acbe8779ca01655ed4427f8edc234693c04c3c9d4c4162f96";
    private static final String UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static volatile byte[] configuredAllowlist;
    public record Operation(String kind, int x, int y, int z, String name, String facing) {
        public String requestLine() { return kind + " " + x + " " + y + " " + z; }
    }
    public record Request(String id, long time, List<Operation> operations) { }
    public interface Guard { void check() throws Exception; }
    public interface Audit { void record(String type, String detail) throws Exception; }
    public interface World {
        Executor executor();
        void validate(long time) throws Exception;
        String inspect(Operation operation) throws Exception;
        void apply(Operation operation) throws Exception;
        void dirty(Operation operation) throws Exception;
    }
    private final Path directory, requestPath;
    private final String session;
    private final Guard guard;
    private final Audit audit;
    private volatile World world;
    private volatile String pending;
    private volatile boolean halted;
    private String consumed;

    public VanillaUpdates(Path directory, String session, Guard guard, Audit audit) {
        this.directory = directory; this.requestPath = directory.resolve("observer-gate-request.txt");
        this.session = session; this.guard = guard; this.audit = audit;
    }
    public boolean worldReady() { return world != null; }
    public String pending() { return pending; }
    public boolean halted() { return halted; }
    void attach(World value) { world = value; }
    public void observe(Object candidate) throws Exception {
        if (world != null || !candidate.getClass().getName().equals("ard")) return;
        McWorld captured = new McWorld(candidate, directory);
        if (captured.ownedClone()) world = captured;
    }
    public static synchronized void configureAllowlist(byte[] bytes) throws Exception {
        if (configuredAllowlist != null) throw new IllegalStateException("Source allowlist already configured");
        if (bytes == null || !HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)).equals(ALLOWLIST_SHA256)) throw new IllegalStateException("Source allowlist checksum mismatch");
        configuredAllowlist = bytes.clone();
    }
    public static Map<String, Operation> allowlist() throws Exception {
        byte[] bytes = configuredAllowlist;
        if (bytes == null) {
            try (var stream = VanillaUpdates.class.getResourceAsStream("/observer-gate-allowlist.txt")) {
                if (stream == null) throw new IllegalStateException("Missing source allowlist");
                bytes = stream.readAllBytes();
            }
        }
        if (!HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)).equals(ALLOWLIST_SHA256)) throw new IllegalStateException("Source allowlist checksum mismatch");
        String[] lines = new String(bytes, StandardCharsets.UTF_8).strip().split("\n");
        if (!lines[0].equals(SOURCE_SHA256) || lines.length != 74) throw new IllegalStateException("Unexpected source allowlist");
        Map<String, Operation> result = new LinkedHashMap<>();
        for (int i = 1; i < lines.length; i++) {
            String[] p = lines[i].split(" ");
            Operation op = new Operation(p[0], Integer.parseInt(p[1]), Integer.parseInt(p[2]), Integer.parseInt(p[3]), p[4], p[5]);
            if (result.put(op.requestLine(), op) != null) throw new IllegalStateException("Duplicate source allowlist entry");
        }
        return Collections.unmodifiableMap(result);
    }
    public static Request parse(String body, String session) throws Exception {
        if (body.length() > 16384 || !body.endsWith("\n") || body.indexOf('\r') >= 0) throw new IllegalArgumentException("Invalid request encoding");
        String[] p = body.split("\n");
        if (p.length < 7 || p.length > 86 || !p[0].equals("OG_UPDATE_V1") || !p[1].equals(Long.toString(ProcessHandle.current().pid())) || !p[2].equals(session) || !p[3].matches(UUID_PATTERN) || !p[4].matches("0|[1-9][0-9]{0,15}") || !p[5].equals(SOURCE_SHA256)) throw new IllegalArgumentException("Request identity or source mismatch");
        Map<String, Operation> allowed = allowlist();
        Set<String> unique = new HashSet<>(); List<Operation> operations = new ArrayList<>();
        for (int i = 6; i < p.length; i++) {
            Operation operation = allowed.get(p[i]);
            if (operation == null || !unique.add(p[i])) throw new IllegalArgumentException("Unlisted or duplicate request target");
            operations.add(operation);
        }
        return new Request(p[3], Long.parseLong(p[4]), List.copyOf(operations));
    }
    private static String json(String value) { return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\""; }
    private static void durable(Path target, String value, boolean createOnly) throws Exception {
        try (FileChannel file = FileChannel.open(target, StandardOpenOption.WRITE, createOnly ? StandardOpenOption.CREATE_NEW : StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            ByteBuffer bytes = StandardCharsets.UTF_8.encode(value);
            while (bytes.hasRemaining()) file.write(bytes);
            file.force(true);
        }
    }
    private void result(Request request, String status, int completed, String error) throws Exception {
        Path target = directory.resolve("observer-gate-request-" + request.id() + ".json");
        Path temp = target.resolveSibling(target.getFileName() + ".tmp");
        durable(temp, "{\"requestId\":" + json(request.id()) + ",\"pid\":" + ProcessHandle.current().pid() + ",\"session\":" + json(session) + ",\"sourceSha256\":" + json(SOURCE_SHA256) + ",\"gameTime\":" + request.time() + ",\"status\":" + json(status) + ",\"completed\":" + completed + ",\"error\":" + (error == null ? "null" : json(error)) + "}\n", false);
        Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
    public synchronized void poll() throws Exception {
        if (pending != null || halted || world == null || !Files.exists(requestPath)) return;
        Request request = null;
        try {
            if (Files.isSymbolicLink(requestPath) || Files.size(requestPath) > 16384) throw new IllegalArgumentException("Invalid request file");
            String body = Files.readString(requestPath, StandardCharsets.UTF_8);
            if (body.equals(consumed)) return;
            request = parse(body, session);
            guard.check();
            Path ledger = directory.resolve("observer-gate-requests");
            Files.createDirectories(ledger);
            durable(ledger.resolve(request.id() + ".intent"), body, true);
            consumed = body; pending = request.id();
            audit.record("update-request-intent", ",\"requestId\":" + json(request.id()) + ",\"operations\":" + request.operations().size());
            Request claimed = request; World captured = world;
            captured.executor().execute(() -> execute(claimed, captured));
        } catch (Throwable error) {
            halted = true;
            audit.record("update-request-rejected", ",\"error\":" + json(error.toString()));
            if (request != null) result(request, "failed", 0, error.toString());
        }
    }
    private void execute(Request request, World captured) {
        int completed = 0;
        try {
            guard.check(); captured.validate(request.time());
            for (Operation op : request.operations()) captured.inspect(op);
            for (Operation op : request.operations()) {
                String detail = ",\"requestId\":" + json(request.id()) + ",\"operation\":" + json(op.requestLine());
                String before = captured.inspect(op);
                audit.record("update-operation-intent", detail + ",\"before\":" + json(before));
                guard.check(); captured.validate(request.time()); captured.inspect(op);
                captured.apply(op); captured.dirty(op);
                completed++;
                audit.record("update-operation-result", detail + ",\"before\":" + json(before) + ",\"after\":" + json(captured.inspect(op)));
            }
            guard.check(); captured.validate(request.time());
            pending = null;
            audit.record("update-request-complete", ",\"requestId\":" + json(request.id()) + ",\"completed\":" + completed);
            result(request, "succeeded", completed, null);
        } catch (Throwable error) {
            halted = true; pending = null;
            try { audit.record("update-request-failed", ",\"requestId\":" + json(request.id()) + ",\"completed\":" + completed + ",\"error\":" + json(error.toString())); result(request, "failed", completed, error.toString()); }
            catch (Throwable auditFailure) { System.err.println("Observer update result is indeterminate: " + auditFailure); }
        } finally { pending = null; }
    }
    static final class McWorld implements World {
        final Object world, server;
        final Path directory;
        final ClassLoader loader;
        McWorld(Object world, Path directory) throws Exception { this.world = world; this.server = call(world, "p"); this.directory = directory.toRealPath(); this.loader = world.getClass().getClassLoader(); }
        Class<?> type(String name) throws Exception { return Class.forName(name, false, loader); }
        static Object call(Object object, String name) throws Exception { return object.getClass().getMethod(name).invoke(object); }
        Object pos(Operation op) throws Exception { return type("ji").getConstructor(int.class, int.class, int.class).newInstance(op.x(), op.y(), op.z()); }
        boolean ownedClone() throws Exception {
            Path storage = (Path) server.getClass().getMethod("a", type("eve")).invoke(server, type("eve").getField("l").get(null));
            return (Integer) call(server, "S") == 25567 && call(server, "w").equals("127.0.0.1") && ((Path) call(server, "D")).toRealPath().equals(directory) && storage.toRealPath().equals(directory.resolve("world").toRealPath()) && call(server, "J") == world;
        }
        public Executor executor() { return (Executor) server; }
        public void validate(long time) throws Exception {
            if (!(Boolean) call(server, "bx") || !ownedClone()) throw new IllegalStateException("Not the owned clone overworld main thread");
            Object ticks = call(server, "aP");
            if (!(Boolean) call(ticks, "l") || (Integer) call(ticks, "k") != 0 || (Boolean) call(ticks, "i") || (Boolean) call(ticks, "a") || (Float) call(ticks, "f") != 20.0f || (Long) call(world, "ad") != time) throw new IllegalStateException("Clone is not frozen and quiescent at the expected gametime");
        }
        Object state(Operation op) throws Exception {
            Object position = pos(op);
            if (!(Boolean) world.getClass().getMethod("p", type("ji")).invoke(world, position)) throw new IllegalStateException("Target chunk is not already loaded");
            return world.getClass().getMethod("a_", type("ji")).invoke(world, position);
        }
        public String inspect(Operation op) throws Exception {
            Object state = state(op), block = call(state, "b");
            String text = state.toString();
            if (!text.startsWith("Block{minecraft:" + op.name() + "}[") || !type(op.kind().equals("PISTON_NEIGHBOR") ? "dwr" : "dqv").isInstance(block)) throw new IllegalStateException("Actual block type differs from source at " + op.requestLine());
            String props = text.substring(text.indexOf('[') + 1, text.length() - 1);
            Set<String> values = Set.of(props.split(","));
            if (op.kind().equals("PISTON_NEIGHBOR")) {
                if (!values.contains("facing=" + op.facing())) throw new IllegalStateException("Piston source facing mismatch");
            } else if (!values.contains("type=top") || !values.contains("waterlogged=true")) throw new IllegalStateException("Water target is not an existing waterlogged top slab");
            return text;
        }
        public void apply(Operation op) throws Exception {
            Object position = pos(op);
            if (op.kind().equals("PISTON_NEIGHBOR")) {
                Object block = call(state(op), "b");
                world.getClass().getMethod("b", type("ji"), type("djn"), type("eui")).invoke(world, position, block, null);
            } else {
                Object water = call(call(state(op), "y"), "a");
                if (water != type("etb").getField("c").get(null)) throw new IllegalStateException("Existing slab fluid is not vanilla source water");
                int delay = (Integer) water.getClass().getMethod("a", type("dgm")).invoke(water, world);
                if (delay != 5) throw new IllegalStateException("Unexpected vanilla water tick delay");
                type("dgy").getMethod("a", type("ji"), type("esz"), int.class).invoke(world, position, water, delay);
            }
        }
        public void dirty(Operation op) throws Exception { call(world.getClass().getMethod("m", type("ji")).invoke(world, pos(op)), "i"); }
    }
}
