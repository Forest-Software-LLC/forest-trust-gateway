import { Container, ContainerProxy } from "@cloudflare/containers";

// Required by @cloudflare/containers >=0.1 for the outboundByHost mechanism:
// the runtime invokes this WorkerEntrypoint via ctx.exports to proxy
// container-originated requests back through Worker bindings.
export { ContainerProxy };

function buildContainerEnv(env: Env): { NODE_ENV: string } & Record<string, string> {
    const out: Record<string, string> = {
        NODE_ENV: "production",
        PORT: "8080",
    };
    for (const [key, val] of Object.entries(env)) {
        if (typeof val === "string") {
            out[key] = val;
        }
    }
    return out as { NODE_ENV: string } & Record<string, string>;
}

export class GatewayContainer extends Container<Env> {
    defaultPort = 8080;
    sleepAfter = "10m";
    envVars = { NODE_ENV: "production" };
    enableInternet = true;

    constructor(ctx: DurableObjectState<Env>, env: Env) {
        super(ctx, env);
        this.envVars = buildContainerEnv(env);
    }

    override onStart() {
        console.log("[container] onStart: boot OK");
    }
    override onStop() {
        console.log("[container] onStop: shutting down");
    }
    override onError(err: unknown) {
        console.error("[container] onError:", err);
    }
}

/*
    Outbound handler: this is the actual mechanism that lets code running
    INSIDE the container (the Fastify app, via internalApiClient.ts's plain
    `fetch`) reach forest-api's internal routes through the Service Binding
    declared in wrangler.jsonc. A container has no direct access to Worker
    bindings on its own — Cloudflare's documented fix is exactly this:
    map a virtual hostname to a handler that runs in the Workers runtime
    (with `env` available) and forwards the request through the binding.

    Set BACKEND_INTERNAL_BASE_URL to `http://forest-api.internal` (matching
    the hostname key below) when deploying, so BackendInternalApiClient's
    plain `fetch(...)` calls transparently get routed here — no special
    production-vs-local code path needed in internalApiClient.ts at all.

    Requires @cloudflare/containers >= 0.1: earlier versions silently ignore
    outboundByHost (the assignment is a no-op field, and outbound requests
    fall through to real DNS). The ContainerProxy export and the
    enable_ctx_exports compatibility flag in wrangler.jsonc are both part of
    the same mechanism.
*/
GatewayContainer.outboundByHost = {
    "forest-api.internal": async (request: Request, env: Env) => {
        return env.FOREST_API.fetch(request);
    },
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            const instance = env.GATEWAY_CONTAINER.getByName("forest-trust-gateway");

            const state = await instance.getState();
            if (state.status !== "healthy") {
                await instance.startAndWaitForPorts();
            }

            return (await instance.fetch(request)) as Response;
        } catch (err) {
            // Full detail goes to observability logs only — a public error
            // response must never include internals like stack traces.
            console.error("[worker] fetch handler threw:", err);
            return new Response(
                JSON.stringify({ error: "gateway_unavailable" }),
                { status: 502, headers: { "content-type": "application/json" } }
            );
        }
    }
} satisfies ExportedHandler<Env>;
