/*
 * A2A 最小 Java Agent —— 只依赖 JDK（17+），不用任何第三方库。
 *
 * 编译：
 *     javac A2aMiniAgent.java
 * 运行：
 *     A2A_PORT=8900 java A2aMiniAgent
 * 自测：
 *     curl -s localhost:8900/.well-known/agent-card.json
 *     curl -s -X POST localhost:8900/a2a -H 'Content-Type: application/json' \
 *       -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"看看机器"}]}}}'
 *
 * 它实现 A2A 里 Agent Studio 真正会用到的三件事：
 *   1. GET  /.well-known/agent-card.json   发现（我叫什么、会哪些技能）
 *   2. POST /a2a                           JSON-RPC：message/send、tasks/get、tasks/cancel
 *   3. GET  /health                        探活
 *
 * 为什么手写 JSON：贴进任何 Spring Boot / Quarkus 项目时，把 Json 类换掉、
 * 把 HttpServer 换掉即可；这个小文件的目的是"看得懂协议"，不是生产脚手架。
 */

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

public class A2aMiniAgent {

    // ── 配置（环境变量）──────────────────────────────────────────────
    static final int PORT = Integer.parseInt(env("A2A_PORT", "8900"));
    static final String NAME = env("A2A_NAME", "Java 巡检助手");
    static final String TOKEN = env("A2A_TOKEN", "");   // 非空则校验 Bearer
    static final String PUBLIC_URL = env("A2A_PUBLIC_URL", "http://127.0.0.1:" + PORT);

    /** 任务表：id → Task。真项目应落库；这里内存足够演示。 */
    static final Map<String, Map<String, Object>> TASKS = new ConcurrentHashMap<>();

    static String env(String k, String dft) {
        String v = System.getenv(k);
        return v == null || v.isBlank() ? dft : v.trim();
    }

    public static void main(String[] args) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);
        server.createContext("/.well-known/agent-card.json", ex -> {
            if (!"GET".equals(ex.getRequestMethod())) { sendText(ex, 405, "method not allowed"); return; }
            // 卡片不鉴权 —— 发现必须能匿名，否则注册时连名字都读不到
            sendJson(ex, 200, card());
        });
        server.createContext("/health", ex -> sendJson(ex, 200, Json.obj("status", "ok", "agent", NAME)));
        server.createContext("/a2a", A2aMiniAgent::handleRpc);
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();
        System.out.println("A2A agent 「" + NAME + "」 listening on :" + PORT);
    }

    // ── 1. 发现：agent card ─────────────────────────────────────────
    static Map<String, Object> card() {
        List<Object> skills = new ArrayList<>();
        skills.add(Json.obj(
                "id", "machine-status",
                "name", "机器巡检",
                "description", "读这台机器的操作系统、CPU 负载、内存、磁盘与 Java 运行时信息。只读。",
                "tags", Json.arr("ops", "readonly", "java"),
                "examples", Json.arr("看看这台机器", "内存和磁盘还剩多少")));

        Map<String, Object> c = Json.obj(
                "protocolVersion", "0.3.0",
                "name", NAME,
                "description", "一台跑在 JVM 上的小 agent，暴露 A2A 接口供平台调用。只读不写。",
                "url", PUBLIC_URL.replaceAll("/+$", "") + "/a2a",
                "preferredTransport", "JSONRPC",
                "version", "1",
                "capabilities", Json.obj(
                        "streaming", false,
                        "pushNotifications", false,
                        "stateTransitionHistory", false),
                "defaultInputModes", Json.arr("text/plain"),
                "defaultOutputModes", Json.arr("text/plain"),
                "skills", skills);
        // additionalInterfaces 不是必须的；平台只认 url + preferredTransport
        c.put("additionalInterfaces", Json.arr(Json.obj(
                "url", PUBLIC_URL.replaceAll("/+$", "") + "/a2a",
                "transport", "JSONRPC")));
        return c;
    }

    // ── 2. 调用：JSON-RPC ───────────────────────────────────────────
    static void handleRpc(HttpExchange ex) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) { sendText(ex, 405, "method not allowed"); return; }
        if (!TOKEN.isBlank()) {
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            if (auth == null || !auth.equals("Bearer " + TOKEN)) {
                sendJson(ex, 401, Json.obj("jsonrpc", "2.0", "id", null,
                        "error", Json.obj("code", -32001, "message", "鉴权失败")));
                return;
            }
        }

        Object parsed;
        try {
            parsed = Json.parse(readAll(ex.getRequestBody()));
        } catch (RuntimeException bad) {
            rpcError(ex, null, -32700, "解析失败");
            return;
        }
        if (!(parsed instanceof Map)) { rpcError(ex, null, -32600, "请求不是 JSON 对象"); return; }
        @SuppressWarnings("unchecked")
        Map<String, Object> req = (Map<String, Object>) parsed;

        Object id = req.get("id");
        String method = str(req.get("method"));
        if (method == null) { rpcError(ex, id, -32600, "缺少 method"); return; }

        switch (method) {
            case "message/send" -> {
                String text = extractText(req).trim();
                String taskId = "task-" + UUID.randomUUID().toString().substring(0, 12);
                Map<String, Object> task = Json.obj("id", taskId, "kind", "task");
                TASKS.put(taskId, task);
                // 同步干完（真实场景可以异步：先把 task 置 working，再在后台线程里跑完）
                String answer = handleText(text);
                task.put("status", Json.obj(
                        "state", "completed",
                        "message", Json.obj("role", "agent",
                                "parts", Json.arr(Json.obj("kind", "text", "text", answer)))));
                task.put("artifacts", Json.arr(Json.obj(
                        "artifactId", "art-" + taskId,
                        "name", "answer",
                        "parts", Json.arr(Json.obj("kind", "text", "text", answer)))));
                rpcResult(ex, id, task);
            }
            case "tasks/get" -> {
                String tid = paramId(req);
                Map<String, Object> task = tid == null ? null : TASKS.get(tid);
                if (task == null) { rpcError(ex, id, -32001, "任务不存在: " + tid); return; }
                rpcResult(ex, id, task);
            }
            case "tasks/cancel" -> {
                String tid = paramId(req);
                Map<String, Object> task = tid == null ? null : TASKS.get(tid);
                if (task == null) { rpcError(ex, id, -32001, "任务不存在: " + tid); return; }
                task.put("status", Json.obj("state", "canceled"));
                rpcResult(ex, id, task);
            }
            default -> rpcError(ex, id, -32601, "不支持的方法: " + method);
        }
    }

    /** 从 params.message.parts[] 里拼出文本。 */
    static String extractText(Map<String, Object> req) {
        Object params = req.get("params");
        if (!(params instanceof Map)) return "";
        Object msg = ((Map<?, ?>) params).get("message");
        if (!(msg instanceof Map)) return "";
        Object parts = ((Map<?, ?>) msg).get("parts");
        if (!(parts instanceof List)) return "";
        StringBuilder sb = new StringBuilder();
        for (Object p : (List<?>) parts) {
            if (p instanceof Map && "text".equals(str(((Map<?, ?>) p).get("kind")))) {
                String t = str(((Map<?, ?>) p).get("text"));
                if (t != null) sb.append(t).append('\n');
            }
        }
        return sb.toString();
    }

    static String paramId(Map<String, Object> req) {
        Object p = req.get("params");
        return p instanceof Map ? str(((Map<?, ?>) p).get("id")) : null;
    }

    // ── 3. 真活：这台机器什么样 ─────────────────────────────────────
    static String handleText(String text) {
        String low = text == null ? "" : text.toLowerCase();
        if (low.contains("ping") || low.contains("在吗")) {
            return "pong（我是 " + NAME + "，A2A 链路正常）";
        }
        Runtime rt = Runtime.getRuntime();
        com.sun.management.OperatingSystemMXBean os =
                (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
        long totalMb = os.getTotalMemorySize() / 1024 / 1024;
        long freeMb = os.getFreeMemorySize() / 1024 / 1024;
        long diskTotalGb = new java.io.File(".").getTotalSpace() / 1024 / 1024 / 1024L;
        long diskFreeGb = new java.io.File(".").getUsableSpace() / 1024 / 1024 / 1024L;

        return String.join("\n",
                "主机：" + osName() + "（" + os.getAvailableProcessors() + " 核，"
                        + os.getArch() + "）",
                "CPU 负载：" + String.format("%.1f%%", os.getCpuLoad() * 100),
                "内存：已用 " + (totalMb - freeMb) + " / " + totalMb + " MB",
                "磁盘：可用 " + diskFreeGb + " / " + diskTotalGb + " GB",
                "JVM：Java " + System.getProperty("java.version")
                        + "，堆上限 " + rt.maxMemory() / 1024 / 1024 + " MB",
                "响应时间：" + java.time.LocalDateTime.now()
                        .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
    }

    static String osName() {
        return System.getProperty("os.name") + " " + System.getProperty("os.version");
    }

    // ── HTTP / JSON-RPC 小工具 ──────────────────────────────────────
    static void rpcResult(HttpExchange ex, Object id, Object result) throws IOException {
        sendJson(ex, 200, Json.obj("jsonrpc", "2.0", "id", id, "result", result));
    }

    static void rpcError(HttpExchange ex, Object id, int code, String message) throws IOException {
        sendJson(ex, 200, Json.obj("jsonrpc", "2.0", "id", id,
                "error", Json.obj("code", code, "message", message)));
    }

    static void sendJson(HttpExchange ex, int code, Object body) throws IOException {
        byte[] bytes = Json.write(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    static void sendText(HttpExchange ex, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8);
    }

    static String str(Object o) { return o == null ? null : String.valueOf(o); }

    /** 极简 JSON：只够读 JSON-RPC 请求、写 Task 回包。生产项目换成 Jackson。 */
    static final class Json {
        static Map<String, Object> obj(Object... kv) {
            Map<String, Object> m = new LinkedHashMap<>();
            for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
            return m;
        }

        static List<Object> arr(Object... items) {
            List<Object> l = new ArrayList<>();
            for (Object o : items) l.add(o);
            return l;
        }

        static String write(Object o) {
            StringBuilder sb = new StringBuilder();
            write(o, sb);
            return sb.toString();
        }

        @SuppressWarnings("unchecked")
        static void write(Object o, StringBuilder sb) {
            if (o == null) { sb.append("null"); return; }
            if (o instanceof String s) { quote(s, sb); return; }
            if (o instanceof Number || o instanceof Boolean) { sb.append(o); return; }
            if (o instanceof Map<?, ?> m) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    quote(String.valueOf(e.getKey()), sb);
                    sb.append(':');
                    write(e.getValue(), sb);
                }
                sb.append('}');
                return;
            }
            if (o instanceof List<?> l) {
                sb.append('[');
                for (int i = 0; i < l.size(); i++) {
                    if (i > 0) sb.append(',');
                    write(l.get(i), sb);
                }
                sb.append(']');
                return;
            }
            quote(String.valueOf(o), sb);
        }

        static void quote(String s, StringBuilder sb) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                    }
                }
            }
            sb.append('"');
        }

        static Object parse(String s) {
            P p = new P(s);
            Object v = p.value();
            p.ws();
            if (!p.done()) throw new RuntimeException("多余字符 at " + p.i);
            return v;
        }

        static final class P {
            final String s; int i;
            P(String s) { this.s = s; }
            boolean done() { return i >= s.length(); }
            void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
            char peek() { if (done()) throw new RuntimeException("意外结束"); return s.charAt(i); }

            Object value() {
                ws();
                char c = peek();
                if (c == '{') return object();
                if (c == '[') return array();
                if (c == '"') return string();
                if (c == 't') { expect("true"); return Boolean.TRUE; }
                if (c == 'f') { expect("false"); return Boolean.FALSE; }
                if (c == 'n') { expect("null"); return null; }
                return number();
            }

            void expect(String lit) {
                if (!s.startsWith(lit, i)) throw new RuntimeException("期望 " + lit);
                i += lit.length();
            }

            Map<String, Object> object() {
                Map<String, Object> m = new LinkedHashMap<>();
                i++; ws();
                if (peek() == '}') { i++; return m; }
                while (true) {
                    ws(); String k = string(); ws();
                    if (peek() != ':') throw new RuntimeException("期望 :");
                    i++;
                    m.put(k, value());
                    ws();
                    char c = peek();
                    if (c == ',') { i++; continue; }
                    if (c == '}') { i++; return m; }
                    throw new RuntimeException("期望 , 或 }");
                }
            }

            List<Object> array() {
                List<Object> l = new ArrayList<>();
                i++; ws();
                if (peek() == ']') { i++; return l; }
                while (true) {
                    l.add(value()); ws();
                    char c = peek();
                    if (c == ',') { i++; continue; }
                    if (c == ']') { i++; return l; }
                    throw new RuntimeException("期望 , 或 ]");
                }
            }

            String string() {
                if (peek() != '"') throw new RuntimeException("期望字符串");
                i++;
                StringBuilder sb = new StringBuilder();
                while (true) {
                    char c = s.charAt(i++);
                    if (c == '"') return sb.toString();
                    if (c != '\\') { sb.append(c); continue; }
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'u' -> { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                        default -> sb.append(e);
                    }
                }
            }

            Object number() {
                int start = i;
                while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
                String n = s.substring(start, i);
                if (n.isEmpty()) throw new RuntimeException("不是数字 at " + start);
                if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
                try { return Long.parseLong(n); } catch (NumberFormatException ex) { return Double.parseDouble(n); }
            }
        }
    }
}
