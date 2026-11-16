import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { navigatedAuthority, startOriginBoundary } from "../boundary.mjs";

// Two loopback origins. "opened" stands for a page the client opened; it also
// redirects to "foreign", which serves a marker and counts every connection.
const MARKER = "foreign-origin-marker";
async function origins() {
  const state = { connections: 0, requests: [] };
  const foreign = http.createServer((req, res) => {
    state.requests.push(req.url);
    res.end(MARKER);
  });
  foreign.on("connection", () => state.connections++);
  const opened = http.createServer((req, res) => {
    if (req.url === "/hop") {
      res.writeHead(302, { Location: `${state.foreign}/after-hop` });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/plain", "X-Seen-Host": "yes" });
    res.end(`opened ${req.method} ${req.url} host=${req.headers.host}`);
  });
  for (const server of [foreign, opened])
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.foreign = `http://127.0.0.1:${foreign.address().port}`;
  state.opened = `http://127.0.0.1:${opened.address().port}`;
  state.close = async () => {
    for (const server of [foreign, opened]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
  return state;
}
// One request through the proxy, as a browser sends it: the absolute target
// in the request line.
function through(proxy, target, { method = "GET", headers = {} } = {}) {
  const { hostname, port } = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: hostname, port, method, path: target, headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}
const navigate = (url) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "browser_navigate", arguments: { url } },
});

test("only an explicit client navigation to a plain-HTTP URL names an origin", () => {
  assert.equal(
    navigatedAuthority(navigate("http://127.0.0.1:4100/index.html")),
    "127.0.0.1:4100",
  );
  assert.equal(
    navigatedAuthority(navigate("http://Host.Docker.Internal/x")),
    "host.docker.internal",
  );
  assert.equal(
    navigatedAuthority({
      method: "tools/call",
      params: {
        name: "browser_tabs",
        arguments: { action: "new", url: "http://[::1]:4100/" },
      },
    }),
    "[::1]:4100",
  );
  for (const message of [
    navigate("https://127.0.0.1:4100/"),
    navigate("file:///etc/hosts"),
    navigate("data:text/html,x"),
    navigate("javascript:1"),
    navigate("127.0.0.1:4100/"),
    navigate("localhost:4100/"),
    navigate("http://user@127.0.0.1:4100/"),
    navigate("not a url"),
    navigate(undefined),
    navigate({ href: "http://127.0.0.1:4100/" }),
    // Not a navigation by the client.
    {
      method: "tools/call",
      params: {
        name: "browser_tabs",
        arguments: { action: "select", url: "http://127.0.0.1:4100/" },
      },
    },
    {
      method: "tools/call",
      params: {
        name: "browser_click",
        arguments: { target: "e1", url: "http://127.0.0.1:4100/" },
      },
    },
    {
      method: "tools/call",
      params: {
        name: "browser_type",
        arguments: { text: "http://127.0.0.1:4100/" },
      },
    },
    { method: "tools/list", params: { name: "browser_navigate" } },
    {
      method: "notifications/message",
      params: {
        name: "browser_navigate",
        arguments: { url: "http://127.0.0.1:4100/" },
      },
    },
    { result: { name: "browser_navigate" } },
    null,
    "browser_navigate",
  ])
    assert.equal(navigatedAuthority(message), undefined);
});

test("the boundary forwards to opened origins only and never contacts another origin", async () => {
  const o = await origins();
  const boundary = await startOriginBoundary();
  try {
    assert.equal(boundary.proxy.bypass, "<-loopback>");
    assert.match(boundary.proxy.server, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    // Positive control: the foreign origin serves its marker to this test.
    assert.equal(await (await fetch(`${o.foreign}/trusted`)).text(), MARKER);
    assert.deepEqual(o.requests, ["/trusted"]);
    const trusted = o.connections;
    // Nothing is allowed before the client opens an origin.
    const before = await through(boundary.proxy, `${o.opened}/page`);
    assert.equal(before.status, 403);
    assert.match(before.body, /Blocked by the browser origin boundary/);
    boundary.observe(navigate(`${o.opened}/index.html`));
    const page = await through(boundary.proxy, `${o.opened}/page?x=1`, {
      headers: { "Proxy-Connection": "keep-alive", Upgrade: "h2c" },
    });
    assert.equal(page.status, 200);
    assert.equal(
      page.body,
      `opened GET /page?x=1 host=${new URL(o.opened).host}`,
    );
    assert.equal(page.headers["x-seen-host"], "yes");
    // The Host header cannot redirect a forwarded request.
    const spoofed = await through(boundary.proxy, `${o.opened}/page`, {
      headers: { Host: new URL(o.foreign).host },
    });
    assert.equal(
      spoofed.body,
      `opened GET /page host=${new URL(o.opened).host}`,
    );
    // A redirect is returned, not followed; the browser's next request, to
    // the foreign origin, is refused.
    const hop = await through(boundary.proxy, `${o.opened}/hop`);
    assert.equal(hop.status, 302);
    assert.equal(hop.headers.location, `${o.foreign}/after-hop`);
    for (const target of [
      hop.headers.location,
      `${o.foreign}/`,
      // Another port, scheme or spelling of an opened origin is another origin.
      `https://${new URL(o.opened).host}/`,
      `http://localhost:${new URL(o.opened).port}/`,
      `http://user@${new URL(o.opened).host}/`,
      `ws://${new URL(o.opened).host}/`,
      "/origin-form",
    ]) {
      const refused = await through(boundary.proxy, target);
      assert.equal(refused.status, 403, target);
      assert.ok(!refused.body.includes(MARKER), target);
    }
    // Node's parser rejects a target that is not a URL before the boundary.
    assert.equal((await through(boundary.proxy, "not-a-url")).status, 400);
    // A method with a body is refused the same way.
    assert.equal(
      (await through(boundary.proxy, `${o.foreign}/post`, { method: "POST" }))
        .status,
      403,
    );
    // The marker's origin saw the trusted request and nothing else.
    assert.deepEqual(o.requests, ["/trusted"]);
    assert.equal(o.connections, trusted);
  } finally {
    await boundary.close();
    await o.close();
  }
});

test("the boundary refuses every tunnel and upgrade without contacting the target", async () => {
  const o = await origins();
  const boundary = await startOriginBoundary();
  const raw = (lines) =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(boundary.proxy.server);
      const socket = net.connect(Number(port), hostname, () =>
        socket.write(lines.join("\r\n") + "\r\n\r\n"),
      );
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
      socket.setTimeout(5000, () => socket.destroy(new Error("no answer")));
    });
  try {
    // Even an opened origin cannot be tunnelled to: HTTPS and WebSocket
    // traffic use CONNECT through an HTTP proxy.
    boundary.observe(navigate(`${o.opened}/`));
    for (const authority of [
      new URL(o.foreign).host,
      new URL(o.opened).host,
      "example.invalid:443",
    ]) {
      const answer = await raw([
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
      ]);
      assert.match(answer, /^HTTP\/1\.1 403 Forbidden\r\n/, authority);
    }
    const upgrade = await raw([
      `GET ${o.foreign}/socket HTTP/1.1`,
      `Host: ${new URL(o.foreign).host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
    ]);
    assert.ok(!upgrade.includes(MARKER));
    assert.ok(!/^HTTP\/1\.1 (101|200)/.test(upgrade));
    assert.equal(o.connections, 0);
    assert.deepEqual(o.requests, []);
  } finally {
    await boundary.close();
    await o.close();
  }
});

test("a closed boundary stops listening", async () => {
  const boundary = await startOriginBoundary();
  await boundary.close();
  await assert.rejects(through(boundary.proxy, "http://127.0.0.1:9/"));
});
