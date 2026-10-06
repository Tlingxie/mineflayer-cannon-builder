package observergate;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;
import java.util.HexFormat;
import java.security.MessageDigest;
import org.objectweb.asm.*;

public final class ObserverTransformer implements ClassFileTransformer {
    public static final String TICK = "(Ldwy;Lard;Lji;Lazh;)V";
    public static final String START = "(Ldgm;Ldgy;Lji;)V";
    public static final String CLASS_SHA256 = "af431b23bc687885b2d75e74018bb7c8cb3d9a3693b6e6a835892fa5c7eef7f7";
    private static final String BRIDGE = "observergate/bridge/GateBridge";

    public static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    public static byte[] transformBytes(byte[] source) {
        if (!sha256(source).equals(CLASS_SHA256)) throw new IllegalArgumentException("Official ObserverBlock class hash mismatch");
        ClassReader reader = new ClassReader(source);
        if (!reader.getClassName().equals("dpb") || !reader.getSuperName().equals("dlr")) throw new IllegalArgumentException("Unexpected ObserverBlock hierarchy");
        int[] structure = new int[5];
        reader.accept(new ClassVisitor(Opcodes.ASM9) {
            @Override public MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
                if (!name.equals("a")) return null;
                boolean tick = desc.equals(TICK), start = desc.equals(START);
                if (!tick && !start) return null;
                if ((access & (Opcodes.ACC_STATIC | Opcodes.ACC_NATIVE | Opcodes.ACC_ABSTRACT)) != 0) throw new IllegalArgumentException("Invalid observer hook access");
                structure[tick ? 0 : 1]++;
                return new MethodVisitor(Opcodes.ASM9) {
                    @Override public void visitMethodInsn(int opcode, String owner, String method, String descriptor, boolean itf) {
                        if (tick && owner.equals("ard") && method.equals("a") && descriptor.equals("(Lji;Ldwy;I)Z")) structure[2]++;
                        if (tick && owner.equals("ard") && method.equals("a") && descriptor.equals("(Lji;Ldjn;I)V")) structure[3]++;
                        if (start && owner.equals("dgy") && method.equals("a") && descriptor.equals("(Lji;Ldjn;I)V")) structure[4]++;
                    }
                };
            }
        }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        if (!java.util.Arrays.equals(structure, new int[]{1, 1, 2, 1, 1})) throw new IllegalArgumentException("Observer methods did not match the expected schedule/state structure");
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            @Override public MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
                MethodVisitor target = super.visitMethod(access, name, desc, signature, exceptions);
                if (!name.equals("a") || (!desc.equals(TICK) && !desc.equals(START))) return target;
                return new MethodVisitor(Opcodes.ASM9, target) {
                    @Override public void visitCode() {
                        super.visitCode();
                        if (desc.equals(TICK)) {
                            visitVarInsn(Opcodes.ALOAD, 1);
                            visitFieldInsn(Opcodes.GETSTATIC, "dpb", "c", "Ldxp;");
                            visitMethodInsn(Opcodes.INVOKEVIRTUAL, "dwy", "c", "(Ldya;)Ljava/lang/Comparable;", false);
                            visitTypeInsn(Opcodes.CHECKCAST, "java/lang/Boolean");
                            visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Boolean", "booleanValue", "()Z", false);
                            visitVarInsn(Opcodes.ALOAD, 2);
                            visitVarInsn(Opcodes.ALOAD, 3);
                            visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "suppressTick", "(ZLjava/lang/Object;Ljava/lang/Object;)Z", false);
                        } else {
                            visitVarInsn(Opcodes.ALOAD, 1);
                            visitVarInsn(Opcodes.ALOAD, 3);
                            visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "suppressSignal", "(Ljava/lang/Object;Ljava/lang/Object;)Z", false);
                        }
                        Label original = new Label();
                        visitJumpInsn(Opcodes.IFEQ, original);
                        if (desc.equals(TICK)) {
                            visitVarInsn(Opcodes.ALOAD, 2);
                            visitVarInsn(Opcodes.ALOAD, 3);
                            visitMethodInsn(Opcodes.INVOKEVIRTUAL, "ard", "m", "(Lji;)Ldzd;", false);
                            visitMethodInsn(Opcodes.INVOKEVIRTUAL, "dzd", "i", "()V", false);
                            visitVarInsn(Opcodes.ALOAD, 2);
                            visitVarInsn(Opcodes.ALOAD, 3);
                            visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "chunkMarkedUnsaved", "(Ljava/lang/Object;Ljava/lang/Object;)V", false);
                        }
                        visitInsn(Opcodes.RETURN);
                        visitLabel(original);
                        visitFrame(Opcodes.F_SAME, 0, null, 0, null);
                    }
                };
            }
        }, 0);
        return writer.toByteArray();
    }

    @Override public byte[] transform(ClassLoader loader, String name, Class<?> redefining, ProtectionDomain domain, byte[] bytes) {
        if (!"dpb".equals(name)) return null;
        try {
            if (redefining != null) throw new IllegalStateException("Runtime retransformation is unsupported");
            ObserverGateAgent.verifyTargetJar(java.nio.file.Path.of(domain.getCodeSource().getLocation().toURI()));
            byte[] transformed = transformBytes(bytes);
            ObserverGateAgent.bridge("markHooksReady");
            return transformed;
        } catch (Throwable error) {
            System.err.println("Observer gate transform rejected; terminating instead of loading original behavior: " + error);
            Runtime.getRuntime().halt(71);
            return null;
        }
    }
}
