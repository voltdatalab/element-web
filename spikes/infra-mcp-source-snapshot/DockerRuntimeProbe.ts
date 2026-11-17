/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** Fixed, dependency-free program executed by Node inside the sole running Captain container. */
export const dockerRuntimeProbeSource = String.raw`
(async () => {
    const http = require("node:http");
    const { TextDecoder } = require("node:util");
    const target = JSON.parse(process.argv[1]);
    const observation = {
        host: target.host,
        application: target.application,
        environment: target.environment,
        observedAt: new Date().toISOString(),
        result: "unavailable",
        runtime: null,
        healthHttp: "not_checked",
        applicationVersion: null,
    };
    const get = (path, serviceLookup = false) => new Promise((resolve, reject) => {
        let bytes = 0;
        const timer = setTimeout(() => request.destroy(new Error("Unavailable")), 2000);
        const request = http.get({ socketPath: "/var/run/docker.sock", path, method: "GET" }, (response) => {
            if (response.statusCode !== 200) {
                if (serviceLookup && response.statusCode === 404) observation.result = "not_found";
                response.destroy();
                clearTimeout(timer);
                reject(new Error("Unavailable"));
                return;
            }
            const chunks = [];
            response.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > 131072) request.destroy(new Error("Unavailable"));
                else chunks.push(chunk);
            });
            response.on("end", () => {
                clearTimeout(timer);
                try {
                    if (!response.complete || bytes > 131072) throw new Error("Unavailable");
                    resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
                } catch { reject(new Error("Unavailable")); }
            });
            response.on("error", () => { clearTimeout(timer); reject(new Error("Unavailable")); });
        });
        request.on("error", () => { clearTimeout(timer); reject(new Error("Unavailable")); });
    });
    try {
        const slug = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
        if (Object.keys(target).sort().join(",") !== "application,environment,host,serviceName" ||
            typeof target.host !== "string" || target.host.length > 63 || !slug.test(target.host) ||
            typeof target.application !== "string" || target.application.length > 63 ||
            !slug.test(target.application) ||
            !["staging", "production"].includes(target.environment) ||
            target.serviceName !== "srv-captain--" + target.application) throw new Error("Unavailable");
        const service = await get("/v1.44/services/" + target.serviceName, true);
        if (!service || typeof service.ID !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(service.ID) ||
            service.Spec?.Name !== target.serviceName) throw new Error("Unavailable");
        const desired = service.Spec.Mode?.Replicated?.Replicas;
        if (!Number.isSafeInteger(desired) || desired < 0 || service.Spec.Mode.Global !== undefined) {
            throw new Error("Unavailable");
        }
        const filters = encodeURIComponent(JSON.stringify({ service: [service.ID] }));
        const tasks = await get("/v1.44/tasks?filters=" + filters);
        const states = ["new", "allocated", "pending", "assigned", "accepted", "preparing", "ready", "starting",
            "running", "complete", "shutdown", "failed", "rejected", "remove", "orphaned"];
        if (!Array.isArray(tasks) || tasks.length > 4096 || tasks.some((task) =>
            !task || task.ServiceID !== service.ID || !states.includes(task.Status?.State))) {
            throw new Error("Unavailable");
        }
        const running = tasks.filter((task) => task.Status.State === "running");
        // Replicated Slots deduplicate update overlap; neither NodeID nor task ID identifies a replica.
        const slots = new Set(running.map((task) => {
            if (!Number.isSafeInteger(task.Slot) || task.Slot <= 0) throw new Error("Unavailable");
            return task.Slot;
        }));
        const imagePattern = new RegExp([
            /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?/.source,
            /[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*/.source,
            /(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.source,
        ].join(""));
        const images = running.map((task) => task.Spec?.ContainerSpec?.Image);
        const validImages = images.every((image) =>
            typeof image === "string" && image.length <= 512 && imagePattern.test(image));
        observation.result = "observed";
        observation.runtime = {
            status: desired === 0 ? (slots.size === 0 ? "stopped" : "degraded") :
                slots.size >= desired ? "running" : "degraded",
            desiredInstances: desired,
            runningInstances: slots.size,
            runningTaskImageRefs: validImages ? [...new Set(images)].sort() : null,
        };
    } catch {}
    observation.observedAt = new Date().toISOString();
    process.stdout.write(JSON.stringify(observation));
})()
`;
