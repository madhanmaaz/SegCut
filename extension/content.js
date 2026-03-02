(async function () {
    if (window.__SEGCUT_INSTANCE__) return;

    // extension resources
    const logo = chrome.runtime.getURL("./images/logo.webp");
    const logoAlt = chrome.runtime.getURL("./images/logo-alt.webp");

    // helpers
    function isIframe() {
        return window.self !== window.top;
    }

    function formatTime(seconds) {
        seconds = Math.floor(seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
    }

    function randomString(length = 16) {
        // If UUID is available and no specific length required
        if (
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function" &&
            length === 36
        ) {
            return crypto.randomUUID();
        }

        const chars =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const charsLength = chars.length;

        // Secure random (browser)
        if (
            typeof crypto !== "undefined" &&
            typeof crypto.getRandomValues === "function"
        ) {
            const array = new Uint8Array(length);
            crypto.getRandomValues(array);

            let result = "";
            for (let i = 0; i < length; i++) {
                result += chars[array[i] % charsLength];
            }
            return result;
        }

        // Fallback (non-secure)
        let result = "";
        for (let i = 0; i < length; i++) {
            result += chars[Math.floor(Math.random() * charsLength)];
        }
        return result;
    }

    function sanitizeFilename(name) {
        return name
            .replace(/[^a-z0-9.\-_]/gi, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "");
    }

    class SegCut {
        constructor() {
            this.panel = null;
            this.currentStart = null;
            this.videoElement = null;
            this.blobElement = null;
            this._videosCache = {
                videos: [],
                streams: [],
            };
            this.store = {
                pageUrl: location.href,
                videoUrl: null,
                parts: [],
                filename: sanitizeFilename(document.title),
            };

            this.VIDEOS = "videos";
            this.STREAMS = "streams";
        }

        async activate() {
            if (document.getElementById("segcut")) return;

            this.createPanel();
            await this.loadDraft();
        }

        deactivate() {
            if (this.panel) {
                this.panel.remove();
                this.panel = null;
            }
        }

        createPanel() {
            this.panel = document.createElement("div");
            this.panel.id = "segcut";

            this.panel.innerHTML = `
                <div class="segcut-header segcut-flex">
                    <button class="segcut-logo">
                        <img src="${logo}" />
                    </button>

                    <div class="segcut-header-content segcut-flex">
                        <a class="segcut-link" href="https://github.com/sponsors/madhanmaaz">Sponsor</a>
                    </div>
                </div>

                <div class="segcut-content">
                    <div class="segcut-hr"></div>

                    <div class="segcut-field">
                        <select class="segcut-video-selector" name="segcut-video-selector">
                            <option value="select-video">Select Video</option>
                        </select>
                    </div>

                    <div class="segcut-flex">
                        <small class="segcut-label">Segments</small>
                        <small class="segcut-marker-status"></small>
                    </div>

                    <ul class="segcut-segments"></ul>

                    <div class="segcut-hr"></div>

                    <div class="segcut-flex">
                        <button class="segcut-button segcut-marker-start">
                            Start
                        </button>

                        <button class="segcut-button segcut-marker-end">
                            End
                        </button>

                        <button class="segcut-button segcut-marker-full">
                            Full
                        </button>
                    </div>

                    <button class="segcut-button segcut-download">
                        Download
                    </button>
                </div>

                <div class="segcut-alert">
                    <div class="segcut-flex">
                        <p>message</p>
                        <button class="segcut-button segcut-button-square">x</button>
                    </div>
                </div>
            `;

            document.body.appendChild(this.panel);
            this.bindUI();
        }

        bindUI() {
            const logoBtn = this.panel.querySelector(".segcut-logo");
            const logoImage = logoBtn.querySelector("img");
            const downloadBtn = this.panel.querySelector(".segcut-download");
            const markerStart = this.panel.querySelector(
                ".segcut-marker-start",
            );
            const markerEnd = this.panel.querySelector(".segcut-marker-end");
            const markerFull = this.panel.querySelector(".segcut-marker-full");
            const alertClose = this.panel.querySelector(".segcut-alert button");

            this.videoSelector = this.panel.querySelector(
                ".segcut-video-selector",
            );
            this.markerStatusElement = this.panel.querySelector(
                ".segcut-marker-status",
            );
            this.segmentListElement =
                this.panel.querySelector(".segcut-segments");
            this.alertElement = this.panel.querySelector(".segcut-alert");
            this.alertTextElement = this.panel.querySelector(".segcut-alert p");

            logoBtn.addEventListener("click", () => {
                const state = this.panel.classList.toggle("active");
                logoImage.src = state ? logoAlt : logo;
            });

            this.videoSelector.addEventListener("focus", async () => {
                this.videoSelector.value = "select-video";
                this.store.videoUrl = null;
                this.clearVideoHighlight();

                const videos = this.getVideos();
                this.renderVideoOptions(videos, this.VIDEOS);
            });

            this.videoSelector.addEventListener("change", (e) => {
                const value = e.target.value;

                const [videoType, videoId] = value.split("_");
                if (!videoId && !videoType) {
                    this.store.videoUrl = null;
                    return;
                }

                const videos = this._videosCache[videoType];
                const selected = videos.find((v) => v.videoId == videoId);
                if (!selected) {
                    this.store.videoUrl = null;
                    return;
                }

                if (videoType === this.VIDEOS) {
                    this.clearVideoHighlight();
                    selected.element?.classList.add("segcut-video-element");
                    this.videoElement = selected.element;
                } else {
                    this.videoElement = this.blobElement;
                }

                this.store.videoUrl = selected.url ?? null;
                this.videoSelector.blur();
                this.updateMarkerStatus(`> ${selected.name}`);
            });

            /* Mark Start */
            markerStart.addEventListener("click", () => {
                if (!this.videoElement || !this.store.videoUrl) {
                    return this.updateMarkerStatus("! Select Video or Stream.");
                }

                this.currentStart = this.videoElement.currentTime;
                this.updateMarkerStatus(`📌 ${formatTime(this.currentStart)}`);
            });

            /* Mark End */
            markerEnd.addEventListener("click", async () => {
                if (!this.videoElement || !this.store.videoUrl) {
                    return this.updateMarkerStatus("! Select Video or Stream.");
                }

                if (this.currentStart === null) {
                    return this.updateMarkerStatus("! Mark startpoint.");
                }

                const endTime = this.videoElement.currentTime;
                if (endTime <= this.currentStart) {
                    this.updateMarkerStatus("❌ Invalid segment");
                    return;
                }

                await this.addSegment(this.currentStart, endTime);
                this.currentStart = null;
            });

            markerFull.addEventListener("click", async () => {
                if (!this.videoElement || !this.store.videoUrl) {
                    return this.updateMarkerStatus("! Select Video or Stream.");
                }

                await this.addSegment(0, this.videoElement.duration);
            });

            downloadBtn.addEventListener("click", () => {
                if (!this.videoElement || !this.store.videoUrl) {
                    return this.updateMarkerStatus("! Select Video or Stream.");
                }

                if (!this.store.parts.length) {
                    return this.updateMarkerStatus("Add Segments");
                }

                this.updateSegmentStatus(null, "📌");
                this.updateMarkerStatus("⌛ Processing...");
                downloadBtn.disabled = true;

                chrome.runtime.sendMessage(
                    {
                        type: "NEW_TASK",
                        data: this.store,
                    },
                    (response) => {
                        if (!response || !response.success) {
                            this.updateAlertMessage(
                                response.message || "Failed to add task.",
                            );
                            this.updateMarkerStatus("");
                        } else {
                            this.updateMarkerStatus("⌛ Downloading...");
                        }

                        downloadBtn.disabled = false;
                    },
                );
            });

            alertClose.addEventListener("click", () => {
                this.alertElement.classList.remove("active");
            });
        }

        renderVideoOptions(videos = [], type) {
            const groupElement = this.getOptionGroup(type, videos.length === 0);
            if (!groupElement) return;

            if (type === this.VIDEOS) {
                groupElement.innerHTML = "";
            }

            const fragment = document.createDocumentFragment();
            videos.forEach((v) => {
                const opt = document.createElement("option");
                opt.value = `${type}_${v.videoId}`;
                opt.textContent = v.name;
                fragment.appendChild(opt);
            });

            groupElement.appendChild(fragment);

            if (type === this.VIDEOS) {
                this._videosCache[type] = videos;
            } else if (type === this.STREAMS) {
                this._videosCache[type] = [
                    ...this._videosCache[type],
                    ...videos,
                ];
            }
        }

        getOptionGroup(type, is0Videos) {
            let groupElement = this.videoSelector.querySelector(
                `[label="${type}"]`,
            );

            if (is0Videos && groupElement) {
                groupElement.remove();
                return null;
            }

            if (!groupElement) {
                groupElement = document.createElement("optgroup");
                groupElement.setAttribute("label", type);
                this.videoSelector.appendChild(groupElement);
            }

            return groupElement;
        }

        async addSegment(startTime, endTime) {
            const segment = {
                segmentId: `seg_${randomString()}`,
                start: formatTime(startTime),
                end: formatTime(endTime),
            };

            const exists = this.store.parts.some(
                (part) =>
                    part.start === segment.start && part.end === segment.end,
            );

            if (exists) {
                this.updateMarkerStatus("⚠ Segment already exists");
                return;
            }

            this.store.parts.push(segment);
            this.renderSegment(segment);

            await this.saveDraft();
            this.updateMarkerStatus("✔ Segment Added");
        }

        renderSegment(segment) {
            const li = document.createElement("li");
            li.className = "segcut-flex";
            li.dataset.id = segment.segmentId;
            li.innerHTML = `
                <span class="segcut-segment-status">📌</span>
                <b>${segment.start}</b> - <b>${segment.end}</b>
                <button class="segcut-button segcut-button-square"><p>x</p></button>
            `;

            const removeBtn = li.querySelector("button");
            removeBtn.addEventListener("click", async () => {
                this.store.parts = this.store.parts.filter(
                    (p) => p.segmentId !== segment.segmentId,
                );

                li.remove();
                await this.saveDraft();
            });

            this.segmentListElement.appendChild(li);
        }

        updateSegmentStatus(segmentId, icon) {
            if (segmentId === null) {
                this.segmentListElement
                    .querySelectorAll(".segcut-segment-status")
                    .forEach((iconElement) => {
                        iconElement.innerText = icon;
                    });
                return;
            }

            const iconElement = this.segmentListElement.querySelector(
                `[data-id="${segmentId}"] .segcut-segment-status`,
            );

            if (!iconElement) return;
            iconElement.innerText = icon;
        }

        updateMarkerStatus(text) {
            this.markerStatusElement.textContent = text;
        }

        updateAlertMessage(message) {
            this.alertTextElement.innerText = message;
            this.alertElement.classList.add("active");
        }

        clearVideoHighlight() {
            const videos = this._videosCache[this.VIDEOS];
            for (const v of videos) {
                v.element?.classList.remove("segcut-video-element");
            }
        }

        getVideos() {
            const videos = [...document.querySelectorAll("video")];
            const results = [];

            for (let i = 0; i < videos.length; i++) {
                const video = videos[i];

                if (!video || video.readyState === 0) continue;

                let url = null;

                // Direct src
                if (video.src && !video.src.startsWith("blob:")) {
                    url = video.src;
                }

                // currentSrc
                else if (
                    video.currentSrc &&
                    !video.currentSrc.startsWith("blob:")
                ) {
                    url = video.currentSrc;
                }

                // blob
                else if (
                    video.src.startsWith("blob:") ||
                    video.currentSrc.startsWith("blob:")
                ) {
                    this.blobElement = video;
                }

                if (!url) {
                    continue;
                }

                results.push({
                    url,
                    element: video,
                    videoId: randomString(),
                    name: video.id || `Video ${i + 1}`,
                });
            }

            return results;
        }

        async saveDraft() {
            await chrome.storage.local.set({
                [this.store.pageUrl]: this.store.parts,
            });
        }

        async loadDraft() {
            const result = await chrome.storage.local.get(this.store.pageUrl);
            const saved = result[this.store.pageUrl] || [];

            this.store.parts = saved;

            saved.forEach((seg) => this.renderSegment(seg));
        }
    }

    const instance = new SegCut();
    window.__SEGCUT_INSTANCE__ = instance;

    const { enabledHosts = {} } =
        await chrome.storage.local.get("enabledHosts");

    if (enabledHosts[location.hostname]) {
        instance.activate();
    }

    chrome.runtime.onMessage.addListener(async (response) => {
        switch (response.type) {
            case "TOGGLE_SEGCUT": {
                const { enabled } = response.data;

                if (enabled) {
                    instance.activate();
                } else {
                    instance.deactivate();
                }

                if (isIframe()) {
                    const host = new URL(location.href).hostname;
                    const { enabledHosts = {} } =
                        await chrome.storage.local.get("enabledHosts");

                    if (enabled) {
                        enabledHosts[host] = true;
                    } else {
                        delete enabledHosts[host];
                    }

                    await chrome.storage.local.set({ enabledHosts });
                }

                break;
            }
        }

        if (!instance.panel) return;

        switch (response.type) {
            case "SEGMENT_STATUS": {
                const { segmentId, status } = response.data;
                let icon = "";

                if (status === "STARTED") {
                    icon = "🏃‍♂️";
                } else if (status === "DONE") {
                    icon = "✔";
                } else if (status === "FAILED") {
                    icon = "❌";
                }

                instance.updateSegmentStatus(segmentId, icon);
                break;
            }

            case "STREAM_URLS": {
                const { videos = [] } = response.data;

                videos.forEach((v) => {
                    v.videoId = randomString();
                });

                instance.renderVideoOptions(videos, instance.STREAMS);
                break;
            }

            case "ALERT": {
                const { success, message, data } = response;
                const { taskDone } = data;

                instance.updateAlertMessage(
                    `${success ? "✔" : "❌"} ${message}`,
                );

                if (taskDone) {
                    instance.updateMarkerStatus("");
                }
                break;
            }

            default:
                break;
        }
    });
})();
