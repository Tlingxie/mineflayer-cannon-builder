import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.jar.JarFile;
import org.objectweb.asm.*;
import observergate.ObserverTransformer;
import observergate.bridge.GateBridge;

public final class GateBehaviorTest {
    public static class Property { }
    public static final class BoolProperty extends Property { }
    public static class Block { }
    public static final class Position {
        public int u() { return 64; }
        public int v() { return -60; }
        public int w() { return 0; }
    }
    public interface Reader { boolean B_(); }
    public interface Access { TickAccess U(); void a(Position pos, Block block, int delay); }
    public interface TickAccess { boolean a(Position pos, Object block); }
    public static final class Random { }
    public static final class Chunk {
        int unsavedMarks;
        public void i() { unsavedMarks++; }
    }
    public static final class State {
        final boolean powered;
        State(boolean powered) { this.powered = powered; }
        public Comparable<?> c(Property property) { return powered; }
        public Object b(Property property, Comparable<?> value) { return new State((Boolean) value); }
    }
    public static final class Level implements Reader, Access {
        public int writes, scheduled, neighbors;
        public final Chunk chunk = new Chunk();
        State lastState;
        public boolean B_() { return false; }
        public TickAccess U() { return (pos, block) -> false; }
        public void a(Position pos, Block block, int delay) { scheduled++; }
        public boolean a(Position pos, State state, int flags) { writes++; lastState = state; return true; }
        public long ad() { return 100; }
        public Chunk m(Position pos) { return chunk; }
    }
    static final Map<String, String> TYPES = Map.ofEntries(
        Map.entry("dpb", "ProbeObserver"), Map.entry("djn", "GateBehaviorTest$Block"),
        Map.entry("dwy", "GateBehaviorTest$State"), Map.entry("ard", "GateBehaviorTest$Level"),
        Map.entry("dgj", "GateBehaviorTest$Level"), Map.entry("ji", "GateBehaviorTest$Position"),
        Map.entry("azh", "GateBehaviorTest$Random"), Map.entry("dya", "GateBehaviorTest$Property"),
        Map.entry("dxp", "GateBehaviorTest$BoolProperty"), Map.entry("dgm", "GateBehaviorTest$Reader"),
        Map.entry("dgy", "GateBehaviorTest$Access"), Map.entry("fcp", "GateBehaviorTest$TickAccess"),
        Map.entry("dzd", "GateBehaviorTest$Chunk"));
    static String type(String name) { return TYPES.getOrDefault(name, name); }
    static String descriptor(String value) {
        for (var item : TYPES.entrySet()) value = value.replace("L" + item.getKey() + ";", "L" + item.getValue() + ";");
        return value;
    }
    static byte[] fixture(byte[] transformed) {
        ClassWriter writer = new ClassWriter(0);
        writer.visit(Opcodes.V21, Opcodes.ACC_PUBLIC, "ProbeObserver", null, type("djn"), null);
        writer.visitField(Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC, "c", descriptor("Ldxp;"), null, null).visitEnd();
        MethodVisitor ctor = writer.visitMethod(Opcodes.ACC_PUBLIC, "<init>", "()V", null, null);
        ctor.visitCode(); ctor.visitVarInsn(Opcodes.ALOAD, 0); ctor.visitMethodInsn(Opcodes.INVOKESPECIAL, type("djn"), "<init>", "()V", false);
        ctor.visitInsn(Opcodes.RETURN); ctor.visitMaxs(1, 1); ctor.visitEnd();
        MethodVisitor neighbors = writer.visitMethod(Opcodes.ACC_PUBLIC, "a", descriptor("(Ldgj;Lji;Ldwy;)V"), null, null);
        neighbors.visitCode(); neighbors.visitVarInsn(Opcodes.ALOAD, 1); neighbors.visitInsn(Opcodes.DUP);
        neighbors.visitFieldInsn(Opcodes.GETFIELD, type("dgj"), "neighbors", "I"); neighbors.visitInsn(Opcodes.ICONST_1); neighbors.visitInsn(Opcodes.IADD);
        neighbors.visitFieldInsn(Opcodes.PUTFIELD, type("dgj"), "neighbors", "I"); neighbors.visitInsn(Opcodes.RETURN); neighbors.visitMaxs(3, 4); neighbors.visitEnd();
        new ClassReader(transformed).accept(new ClassVisitor(Opcodes.ASM9) {
            @Override public MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
                if (!name.equals("a") || (!desc.equals(ObserverTransformer.TICK) && !desc.equals(ObserverTransformer.START))) return null;
                return new MethodVisitor(Opcodes.ASM9, writer.visitMethod(Opcodes.ACC_PUBLIC, name, descriptor(desc), null, exceptions)) {
                    @Override public void visitFieldInsn(int opcode, String owner, String name, String desc) { super.visitFieldInsn(opcode, type(owner), name, descriptor(desc)); }
                    @Override public void visitMethodInsn(int opcode, String owner, String name, String desc, boolean isInterface) { super.visitMethodInsn(opcode, type(owner), name, descriptor(desc), isInterface); }
                    @Override public void visitTypeInsn(int opcode, String name) { super.visitTypeInsn(opcode, type(name)); }
                    @Override public void visitLocalVariable(String name, String desc, String sig, Label start, Label end, int index) { super.visitLocalVariable(name, descriptor(desc), null, start, end, index); }
                    @Override public void visitFrame(int kind, int localsCount, Object[] locals, int stackCount, Object[] stack) {
                        if (locals != null) for (int i = 0; i < localsCount; i++) if (locals[i] instanceof String s) locals[i] = type(s);
                        if (stack != null) for (int i = 0; i < stackCount; i++) if (stack[i] instanceof String s) stack[i] = type(s);
                        super.visitFrame(kind, localsCount, locals, stackCount, stack);
                    }
                };
            }
        }, 0);
        writer.visitEnd();
        return writer.toByteArray();
    }
    static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        byte[] original;
        try (JarFile jar = new JarFile(args[0])) { original = jar.getInputStream(jar.getJarEntry("dpb.class")).readAllBytes(); }
        byte[] transformed = ObserverTransformer.transformBytes(original);
        byte[] wrong = original.clone(); wrong[wrong.length - 1] ^= 1;
        try { ObserverTransformer.transformBytes(wrong); throw new AssertionError("Changed official class accepted"); } catch (IllegalArgumentException expected) { }
        byte[] bytes = fixture(transformed);
        Class<?> probe = new ClassLoader(GateBehaviorTest.class.getClassLoader()) { Class<?> load() { return defineClass("ProbeObserver", bytes, 0, bytes.length); } }.load();
        probe.getField("c").set(null, new BoolProperty());
        Object observer = probe.getConstructor().newInstance();
        Method tick = probe.getMethod("a", State.class, Level.class, Position.class, Random.class);
        Method start = probe.getMethod("a", Reader.class, Access.class, Position.class);
        Path control = Path.of(args[1]);
        GateBridge.initialize(control.toString());
        GateBridge.markHooksReady();
        Position pos = new Position();
        Files.writeString(control, "HOLD\n");
        Level held = new Level();
        tick.invoke(observer, new State(false), held, pos, new Random());
        check(held.chunk.unsavedMarks == 1, "Consumed observer tick did not dirty its chunk for normal save serialization");
        start.invoke(observer, held, held, pos);
        check(held.writes == 0 && held.neighbors == 0 && held.scheduled == 0, "HOLD changed state or scheduled a pulse");
        check(held.chunk.unsavedMarks == 1, "Suppressed startSignal must not add a dirty mark");
        Level falling = new Level();
        tick.invoke(observer, new State(true), falling, pos, new Random());
        check(falling.writes == 1 && !falling.lastState.powered && falling.neighbors == 1 && falling.scheduled == 0, "Falling edge was suppressed");
        check(falling.chunk.unsavedMarks == 0, "The original falling edge received an extra dirty mark");
        Files.delete(control);
        tick.invoke(observer, new State(false), held, pos, new Random());
        check(held.writes == 0 && !GateBridge.controlValid(), "Missing control failed open");
        check(held.chunk.unsavedMarks == 2, "Fail-closed consumed tick did not dirty its chunk");
        Files.writeString(control, "OFFX\n");
        start.invoke(observer, held, held, pos);
        check(held.scheduled == 0 && !GateBridge.controlValid(), "Corrupt control failed open");
        Files.writeString(control, "OFF\n");
        long deadline = System.nanoTime() + 1_000_000_000L;
        while ((!GateBridge.controlValid() || !GateBridge.activeMode().equals("OFF")) && System.nanoTime() < deadline) Thread.sleep(10);
        check(GateBridge.controlValid() && GateBridge.activeMode().equals("OFF"), "Daemon did not acknowledge OFF without a hook");
        Level normal = new Level();
        tick.invoke(observer, new State(false), normal, pos, new Random());
        start.invoke(observer, normal, normal, pos);
        check(normal.writes == 1 && normal.lastState.powered && normal.neighbors == 1 && normal.scheduled == 2, "OFF changed original behavior");
        check(normal.chunk.unsavedMarks == 0, "OFF received an extra dirty mark");
        Files.writeString(control, "HOLD\n");
        System.out.println("OFF HOLD_START HOLD_TICK FALLING MISSING CORRUPT");
    }
}
