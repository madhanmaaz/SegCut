class Socket {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.reconnectDelay = 2000;
        this.connecting = false;
        this.messageCallbacks = [];
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        if (this.connecting) return;

        this.connecting = true;
        this.ws = new WebSocket(this.url);

        this.ws.addEventListener("open", () => {
            console.log("WS Connected");
            this.connecting = false;
        });

        this.ws.addEventListener("message", (e) => {
            this.messageCallbacks.forEach((callback) => {
                try {
                    callback(JSON.parse(e.data));
                } catch {}
            });
        });

        this.ws.addEventListener("close", () => {
            console.log("WS Disconnected");
            this.connecting = false;
            setTimeout(() => this.connect(), this.reconnectDelay);
        });

        this.ws.addEventListener("error", () => {
            this.ws.close();
        });
    }

    async send(data) {
        this.connect();

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }

        this.ws.send(JSON.stringify(data));
    }

    onMessage(callback) {
        this.messageCallbacks.push(callback);
        this.connect();
    }
}

async function updateBadge(tabId, enabled) {
    await chrome.action.setBadgeText({
        tabId,
        text: enabled ? "ON" : "",
    });

    await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: "#e5e5e5",
    });
}

async function syncBadge(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.url) return;

        const host = new URL(tab.url).hostname;
        const { enabledHosts = {} } =
            await chrome.storage.local.get("enabledHosts");

        await updateBadge(tabId, !!enabledHosts[host]);
    } catch {}
}

const socket = new Socket("ws://127.0.0.1:32510");

// badge
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab?.url) return;

    const host = new URL(tab.url).hostname;
    const { enabledHosts = {} } =
        await chrome.storage.local.get("enabledHosts");

    const newState = !enabledHosts[host];
    await updateBadge(tab.id, newState);

    chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_SEGCUT",
        data: {
            enabled: newState,
        },
    });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
    syncBadge(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
        syncBadge(tabId);
    }
});

const STREAM_HEADERS = [
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
];

function parseAttributes(line) {
    const attrs = {};
    const attrString = line.split(":")[1];
    if (!attrString) return attrs;

    attrString.split(",").forEach((pair) => {
        const [key, value] = pair.split("=");
        if (key && value) {
            attrs[key.trim()] = value.replace(/"/g, "").trim();
        }
    });

    return attrs;
}

async function parseMasterPlaylist(masterUrl) {
    try {
        const res = await fetch(masterUrl);
        const contentType = res.headers.get("content-type") || "";

        if (!STREAM_HEADERS.some((type) => contentType.includes(type))) {
            return null;
        }

        const text = await res.text();
        if (!text.startsWith("#EXTM3U")) return null;

        // Media playlist (not master)
        if (!text.includes("#EXT-X-STREAM-INF")) {
            return [
                {
                    url: masterUrl,
                    name: "Auto or Current (Media Playlist)",
                    resolution: null,
                    bandwidth: null,
                    codecs: null,
                    element: null,
                },
            ];
        }

        const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
        const lines = text.split("\n");

        const variantUrls = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.startsWith("#EXT-X-STREAM-INF")) {
                const attrs = parseAttributes(line);
                const nextLine = lines[i + 1]?.trim();

                if (!nextLine || nextLine.startsWith("#")) continue;

                const finalUrl = new URL(nextLine, baseUrl).href;

                const resolution = attrs.RESOLUTION || "Unknown";
                const bandwidth = attrs.BANDWIDTH
                    ? `${Math.round(attrs.BANDWIDTH / 1000)} kbps`
                    : "Unknown";
                const frameRate = attrs["FRAME-RATE"] || null;

                let name = "";

                if (resolution !== "Unknown") {
                    const height = resolution.split("x")[1];
                    name = `${height}p`;
                }

                if (frameRate) {
                    name += ` ${frameRate}fps`;
                }

                name += ` - ${bandwidth}`;

                variantUrls.push({
                    url: finalUrl,
                    name,
                    resolution,
                    bandwidth: attrs.BANDWIDTH || null,
                    codecs: attrs.CODECS || null,
                    element: null,
                });
            }

            if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
                const attrs = parseAttributes(line);

                if (!attrs.URI) continue;

                const finalUrl = new URL(attrs.URI, baseUrl).href;

                variantUrls.push({
                    url: finalUrl,
                    name: `I-Frame ${attrs.RESOLUTION || ""}`,
                    resolution: attrs.RESOLUTION || null,
                    bandwidth: attrs.BANDWIDTH || null,
                    codecs: attrs.CODECS || null,
                    iframe: true,
                    element: null,
                });
            }
        }

        return variantUrls.length ? variantUrls : null;
    } catch (cause) {
        return null;
    }
}

//  Video URL Tracking
chrome.webRequest.onCompleted.addListener(
    async (details) => {
        if (details.tabId === -1) return;

        const url = details.url;
        if (url.includes(".m3u8") || url.match(/\.(mp4|webm)(\?|$)/)) {
            const videos = await parseMasterPlaylist(url);

            if (videos) {
                chrome.tabs.sendMessage(
                    details.tabId,
                    {
                        type: "STREAM_URLS",
                        data: {
                            videos,
                        },
                    },
                    {
                        frameId: details.frameId,
                    },
                );
            }
        }
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest"] },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;

    if (socket.connecting) {
        sendResponse({
            success: false,
            message: "Failed to connect to SegCut desktop app. Try again.",
        });
        return true;
    }

    if (message.type === "NEW_TASK") {
        (async () => {
            try {
                if (!tabId) {
                    sendResponse({ success: false });
                    return;
                }

                const preResponse = await fetch(message.data.videoUrl, {
                    headers: {
                        accept: "*/*",
                        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
                        priority: "u=1, i",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "none",
                        "sec-fetch-storage-access": "active",
                        "sec-gpc": "1",
                    },
                    body: null,
                    method: "HEAD",
                    mode: "cors",
                    credentials: "omit",
                    redirect: "follow",
                });

                const payload = {
                    type: message.type,
                    data: {
                        ...message.data,
                        videoUrl: preResponse.url,
                        tabId,
                        frameId,
                    },
                };

                await socket.send(payload);
                sendResponse({ success: true });
            } catch (cause) {
                console.log(cause);

                sendResponse({
                    success: false,
                    message: "Failed to connect to SegCut desktop app.",
                    error: cause.message,
                });
            }
        })();

        return true;
    }
});

// WebSocket to Tab Messaging
socket.onMessage((response) => {
    if (!response?.data?.tabId || typeof response?.data?.frameId !== "number")
        return;
    const { tabId, frameId } = response.data;

    chrome.tabs.sendMessage(tabId, response, {
        frameId,
    });
});

chrome.runtime.onStartup.addListener(() => {
    socket.connect();
});

chrome.runtime.onInstalled.addListener(() => {
    socket.connect();
});
