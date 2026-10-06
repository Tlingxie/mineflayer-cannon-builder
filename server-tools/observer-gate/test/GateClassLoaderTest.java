import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;

public final class GateClassLoaderTest {
    public static void main(String[] args) throws Exception {
        if (ClassLoader.getSystemResource("observer-gate-allowlist.txt") != null) throw new AssertionError("Bootstrap smoke must not expose bridge resources through the application classpath");
        var urls = new ArrayList<URL>();
        urls.add(Path.of(args[0]).toUri().toURL());
        try (var files = Files.walk(Path.of(args[1]))) {
            for (Path file : files.filter(p -> p.toString().endsWith(".jar")).toList()) urls.add(file.toUri().toURL());
        }
        try (var loader = new URLClassLoader(urls.toArray(URL[]::new), ClassLoader.getPlatformClassLoader()) {
            void spoofed(byte[] bytes) throws Exception {
                var source = new java.security.CodeSource(Path.of(args[2]).toUri().toURL(), (java.security.cert.Certificate[]) null);
                defineClass("dpb", bytes, 0, bytes.length, new java.security.ProtectionDomain(source, null));
            }
        }) {
            if (args.length > 3) {
                try (var jar = new java.util.jar.JarFile(args[0])) { loader.spoofed(jar.getInputStream(jar.getJarEntry("dpb.class")).readAllBytes()); }
                throw new AssertionError("Transformer rejection did not terminate the JVM");
            }
            Class<?> observer = Class.forName("dpb", false, loader);
            observer.getDeclaredMethods();
            Class<?> level = Class.forName("ard", false, loader);
            Class<?> position = Class.forName("ji", false, loader);
            Class<?> server = Class.forName("net.minecraft.server.MinecraftServer", false, loader);
            for (String method : new String[]{"S", "w", "D", "J", "aP", "bx"}) server.getMethod(method);
            server.getMethod("a", Class.forName("eve", false, loader));
            Class.forName("eve", false, loader).getField("l");
            for (String method : new String[]{"p", "a_", "m"}) level.getMethod(method, position);
            level.getMethod("b", position, Class.forName("djn", false, loader), Class.forName("eui", false, loader));
            Class.forName("dgy", false, loader).getMethod("a", position, Class.forName("esz", false, loader), int.class);
            for (String method : new String[]{"l", "k", "i", "a", "f"}) Class.forName("alp", false, loader).getMethod(method);
            Class<?> bridge = Class.forName("observergate.bridge.GateBridge", false, loader);
            if (bridge.getClassLoader() != null) throw new AssertionError("Bridge is not bootstrap-visible");
            String status = Files.readString(Path.of(args[2]).resolveSibling("observer-gate-status.json"));
            if (!status.contains("\"hooksReady\":true")) throw new AssertionError(status);
        }
        System.out.println("BOOTSTRAP_VISIBLE_AND_HOOKS_READY");
    }
}
