package observergate.bridge;

import java.nio.file.*;
import java.util.*;
import java.util.concurrent.Executor;

public final class VanillaUpdatesTest {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static final class World implements VanillaUpdates.World {
        final List<Runnable> queue = new ArrayList<>();
        final List<String> calls = new ArrayList<>();
        boolean frozen = true, main, correct = true;
        int remaining;
        public Executor executor() { return queue::add; }
        public void validate(long time) {
            if (!main || !frozen || remaining != 0 || time != 123) throw new IllegalStateException("World guard rejected");
        }
        public String inspect(VanillaUpdates.Operation op) {
            if (!correct && op.kind().equals("WATER_TICK")) throw new IllegalStateException("Wrong last actual block");
            return "verified existing " + op.kind();
        }
        public void apply(VanillaUpdates.Operation op) { calls.add(op.kind()); }
        public void dirty(VanillaUpdates.Operation op) { calls.add("dirty"); }
        void run() { main = true; queue.remove(0).run(); main = false; }
    }
    static final String SESSION = "11111111-1111-4111-8111-111111111111";
    static String request(String id, String ops) {
        return "OG_UPDATE_V1\n" + ProcessHandle.current().pid() + "\n" + SESSION + "\n" + id + "\n123\n" + VanillaUpdates.SOURCE_SHA256 + "\n" + ops;
    }
    static VanillaUpdates create(Path directory, World world, boolean[] hold, List<String> events) throws Exception {
        Files.createDirectories(directory);
        VanillaUpdates[] holder = new VanillaUpdates[1];
        VanillaUpdates updates = new VanillaUpdates(directory, SESSION, () -> { if (!hold[0]) throw new IllegalStateException("Not HOLD"); }, (type, detail) -> {
            if (type.equals("update-request-complete") || type.equals("update-request-failed")) check(holder[0].pending() == null, "Terminal status was published with stale pending request");
            if (directory.endsWith("off-after-intent") && type.equals("update-operation-intent")) hold[0] = false;
            events.add(type);
        });
        holder[0] = updates;
        updates.attach(world);
        return updates;
    }
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        var allowed = VanillaUpdates.allowlist();
        check(allowed.size() == 73, "Wrong exact source allowlist");
        String piston = allowed.values().stream().filter(op -> op.kind().equals("PISTON_NEIGHBOR")).findFirst().orElseThrow().requestLine();
        String water = "WATER_TICK 90 -52 15";
        for (String scenario : List.of("success", "off-after-queue", "bad-last-target", "pending-step", "wrong-time", "off-after-intent")) {
            Path directory = root.resolve(scenario);
            World world = new World(); boolean[] hold = {true}; List<String> events = new ArrayList<>();
            VanillaUpdates updates = create(directory, world, hold, events);
            String id = UUID.randomUUID().toString();
            String body = request(id, piston + "\n" + water + "\n");
            if (scenario.equals("wrong-time")) body = body.replace("\n123\n", "\n124\n");
            Files.writeString(directory.resolve("observer-gate-request.txt"), body);
            updates.poll();
            check(world.calls.isEmpty() && world.queue.size() == 1, "Daemon changed world instead of queueing");
            if (scenario.equals("off-after-queue")) hold[0] = false;
            if (scenario.equals("bad-last-target")) world.correct = false;
            if (scenario.equals("pending-step")) world.remaining = 1;
            world.run();
            String result = Files.readString(directory.resolve("observer-gate-request-" + id + ".json"));
            if (scenario.equals("success")) {
                check(result.contains("\"status\":\"succeeded\""), result);
                check(world.calls.equals(List.of("PISTON_NEIGHBOR", "dirty", "WATER_TICK", "dirty")), "Unexpected mutation API: " + world.calls);
                updates.poll();
                check(world.queue.isEmpty(), "Completed request was replayed");
            } else {
                check(result.contains("\"status\":\"failed\""), result);
                check(world.calls.isEmpty(), "Rejected batch performed world work");
            }
            check(Files.exists(directory.resolve("observer-gate-requests").resolve(id + ".intent")), "Intent was discarded");
        }
        Path duplicate = root.resolve("duplicate");
        World pending = new World(); boolean[] hold = {true}; List<String> events = new ArrayList<>();
        VanillaUpdates first = create(duplicate, pending, hold, events);
        String id = UUID.randomUUID().toString();
        Files.writeString(duplicate.resolve("observer-gate-request.txt"), request(id, piston + "\n"));
        first.poll();
        VanillaUpdates restart = create(duplicate, pending, hold, events);
        restart.poll();
        check(pending.queue.size() == 1 && restart.halted(), "Unknown durable intent was replayed after restart");
        for (String invalid : List.of("PISTON_NEIGHBOR 0 0 0\n", water + "\n" + water + "\n", "SET_BLOCK 90 -52 15\n")) {
            try { VanillaUpdates.parse(request(UUID.randomUUID().toString(), invalid), SESSION); throw new AssertionError("Invalid request accepted"); }
            catch (IllegalArgumentException expected) { }
        }
        System.out.println("VANILLA_REQUEST_GUARDS_AND_NO_REPLAY");
    }
}
