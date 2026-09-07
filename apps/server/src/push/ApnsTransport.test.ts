import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";
import { expect, it } from "vite-plus/test";
import { createApnsProviderToken, createApnsSender } from "./ApnsTransport.ts";

it("signs an ES256 provider token with Apple claims and a raw P-256 signature", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const token = createApnsProviderToken(
    { key: privateKey, teamId: "TEAM", keyId: "KEY", bundleId: "test.app" },
    1234,
  );
  const [header, claims, signature] = token.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: "KEY",
  });
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
    iss: "TEAM",
    iat: 1234,
  });
  expect(
    NodeCrypto.verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
  ).toBe(true);
});

it("uses HTTP/2, routes APNs topics, reuses JWTs, and reads rejection reasons", async () => {
  const received: { headers: NodeHttp2.IncomingHttpHeaders; body: string }[] = [];
  const origins: string[] = [];
  const server = NodeHttp2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => {
      received.push({ headers, body });
      stream.respond({ ":status": headers[":path"] === "/3/device/dead" ? 410 : 200 });
      stream.end(
        headers[":path"] === "/3/device/dead" ? JSON.stringify({ reason: "Unregistered" }) : "",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sender = createApnsSender(
    { key: privateKey, teamId: "TEAM", keyId: "KEY", bundleId: "test.app" },
    (origin) => {
      origins.push(String(origin));
      return NodeHttp2.connect(`http://127.0.0.1:${address.port}`);
    },
  );
  try {
    const request = {
      token: "abcd",
      environment: "production" as const,
      kind: "alert" as const,
      payload: { aps: { alert: "Ready" } },
    };
    expect(await sender.send(request, 10000)).toEqual({ status: 200 });
    await sender.send({ ...request, kind: "liveactivity" }, 10001);
    expect(
      await sender.send(
        {
          ...request,
          token: "dead",
          environment: "sandbox",
          kind: "background",
          collapseId: "widget",
        },
        13000,
      ),
    ).toEqual({ status: 410, reason: "Unregistered" });
    expect(origins).toEqual(["https://api.push.apple.com", "https://api.sandbox.push.apple.com"]);
    expect(received[0]!.headers["apns-topic"]).toBe("test.app");
    expect(received[1]!.headers["apns-topic"]).toBe("test.app.push-type.liveactivity");
    expect(received[1]!.headers["apns-priority"]).toBe("5");
    expect(received[2]!.headers["apns-push-type"]).toBe("background");
    expect(received[0]!.headers.authorization).toBe(received[1]!.headers.authorization);
    expect(received[0]!.headers.authorization).not.toBe(received[2]!.headers.authorization);
    expect(JSON.parse(received[0]!.body)).toEqual(request.payload);
    await expect(sender.send({ ...request, payload: "😀".repeat(2000) }, 13000)).rejects.toThrow(
      "4096",
    );
  } finally {
    sender.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
