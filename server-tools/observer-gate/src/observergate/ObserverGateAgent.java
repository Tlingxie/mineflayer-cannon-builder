package observergate;

import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.util.Properties;
import java.util.jar.JarFile;

public final class ObserverGateAgent {
    public static final String TARGET_SHA256 = "de9538d2497c8f4174805f3fcedb8ade3060446aa203f351b820ea5bd04adbf4";
    private static Class<?> bridge;

    public static void verifyTargetJar(Path target) throws Exception {
        if (!ObserverTransformer.sha256(Files.readAllBytes(target)).equals(TARGET_SHA256)) throw new IllegalArgumentException("Official inner server-1.21.4.jar hash mismatch");
    }

    static void bridge(String method) throws Exception { bridge.getMethod(method).invoke(null); }

    public static void premain(String control, Instrumentation instrumentation) {
        try {
            if (control == null || !Path.of(control).isAbsolute()) throw new IllegalArgumentException("An absolute observer-gate.control path is required");
            Path agent = Path.of(ObserverGateAgent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            Path helper = agent.resolveSibling("observer-gate-bridge.jar");
            Properties target = new Properties();
            try (var resource = ObserverGateAgent.class.getResourceAsStream("/observer-gate-target.properties")) {
                if (resource == null) throw new IllegalArgumentException("Missing pinned target metadata");
                target.load(resource);
            }
            Path reference = Path.of(URI.create(target.getProperty("targetJarUri")));
            verifyTargetJar(reference);
            try (JarFile jar = new JarFile(reference.toFile())) { ObserverTransformer.transformBytes(jar.getInputStream(jar.getJarEntry("dpb.class")).readAllBytes()); }
            byte[] allowlist;
            try (JarFile jar = new JarFile(helper.toFile())) {
                var entry = jar.getJarEntry("observer-gate-allowlist.txt");
                if (entry == null) throw new IllegalArgumentException("Missing packaged source allowlist");
                allowlist = jar.getInputStream(entry).readNBytes(16385);
            }
            instrumentation.appendToBootstrapClassLoaderSearch(new JarFile(helper.toFile()));
            bridge = Class.forName("observergate.bridge.GateBridge", true, null);
            bridge.getMethod("initialize", String.class, byte[].class).invoke(null, control, allowlist);
            instrumentation.addTransformer(new ObserverTransformer(), false);
            System.err.println("Observer gate armed for official 1.21.4; waiting for both hooks");
        } catch (Throwable error) {
            System.err.println("Observer gate startup rejected: " + error);
            if (error.getCause() != null) System.err.println(error.getCause());
            Runtime.getRuntime().halt(70);
        }
    }
}
