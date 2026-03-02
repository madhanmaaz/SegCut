import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const PORT = 32510;
const wss = new WebSocketServer({ port: PORT });

const DOWNLOAD_DIR = path.join(os.homedir(), "Videos", "SegCut");
const activeTasks = new Map();

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function createResponse({
    success = true,
    type = "OK",
    data = null,
    error = null,
    message = "",
}) {
    return JSON.stringify({
        success,
        type,
        data,
        error,
        message,
    });
}

function safeSend(ws, payload) {
    if (ws.readyState === ws.OPEN) {
        ws.send(payload);
    }
}

function buildFilePath({ dir, filename, start, end, extension = ".mp4" }) {
    if (!filename) filename = "video";

    // Remove extension if already present
    filename = filename.replace(/\.[^/.]+$/, "");

    // Convert 00:00:05 → 00-00-05 (safe for Windows)
    const safeStart = start.replace(/:/g, "-");
    const safeEnd = end.replace(/:/g, "-");

    const baseName = `${filename}_${safeStart}_${safeEnd}`;

    let filePath = path.join(dir, baseName + extension);

    let counter = 1;

    // Prevent overwrite
    while (fs.existsSync(filePath)) {
        filePath = path.join(dir, `${baseName}_${counter}${extension}`);
        counter++;
    }

    return filePath;
}

function buildArgs({ start, end, videoUrl, outputPath, headers }) {
    const base = [
        "-y",

        "-ss",
        start,
        "-to",
        end,

        "-headers",
        headers,

        "-i",
        videoUrl,
    ];

    const videoArgs = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];
    const audioArgs = ["-c:a", "aac", "-b:a", "128k"];

    return [
        ...base,
        ...videoArgs,
        ...audioArgs,
        "-movflags",
        "+faststart",
        outputPath,
    ];
}

function runSegment({ videoUrl, start, end, outputPath, headers }) {
    return new Promise((resolve, reject) => {
        const args = buildArgs({ start, end, videoUrl, outputPath, headers });
        console.log("> ffmpeg", args.join(" "));

        const ffmpeg = spawn("ffmpeg", args);
        ffmpeg.stderr.on("data", (data) => {
            process.stdout.write(data);
        });

        ffmpeg.on("close", (code) => {
            code === 0 ? resolve() : reject(new Error("FFmpeg failed"));
        });

        ffmpeg.on("error", reject);
    });
}

async function runFFmpeg(
    ws,
    { tabId, frameId, videoUrl, parts, headers, filename },
) {
    if (
        typeof tabId === "undefined" ||
        typeof frameId !== "number" ||
        !videoUrl ||
        !Array.isArray(parts)
    ) {
        safeSend(
            ws,
            createResponse({
                success: false,
                type: "ALERT",
                message: "Invalid task payload",
                data: {
                    tabId,
                    frameId,
                },
            }),
        );
        return;
    }

    if (activeTasks.get(tabId)) {
        console.log(
            `${activeTasks.get(tabId)} Task already running for this tab.`,
        );

        safeSend(
            ws,
            createResponse({
                success: false,
                type: "ALERT",
                message: "Task already running for this tab",
                data: {
                    tabId,
                    frameId,
                },
            }),
        );
        return;
    }

    activeTasks.set(tabId, true);

    try {
        for (let i = 0; i < parts.length; i++) {
            const { start, end, segmentId } = parts[i];

            const outputPath = buildFilePath({
                dir: DOWNLOAD_DIR,
                filename,
                start,
                end,
            });

            safeSend(
                ws,
                createResponse({
                    type: "SEGMENT_STATUS",
                    data: {
                        tabId,
                        segmentId,
                        status: "STARTED",
                        frameId,
                    },
                }),
            );

            try {
                await runSegment({ videoUrl, start, end, outputPath, headers });

                safeSend(
                    ws,
                    createResponse({
                        type: "SEGMENT_STATUS",
                        data: {
                            tabId,
                            segmentId,
                            status: "DONE",
                            frameId,
                        },
                    }),
                );
            } catch (segmentError) {
                if (fs.existsSync(outputPath)) {
                    fs.rmSync(outputPath, { recursive: true });
                }

                console.log(`Segment ${segmentId} failed:`, segmentError);

                safeSend(
                    ws,
                    createResponse({
                        success: false,
                        type: "SEGMENT_STATUS",
                        data: {
                            tabId,
                            segmentId,
                            status: "FAILED",
                            error: segmentError.message,
                            frameId,
                        },
                    }),
                );
            }
        }

        safeSend(
            ws,
            createResponse({
                success: true,
                type: "ALERT",
                data: {
                    tabId,
                    frameId,
                    taskDone: true,
                },
                message: "Task completed",
            }),
        );
    } catch (cause) {
        console.error("FFmpeg Error:", cause);

        safeSend(
            ws,
            createResponse({
                success: false,
                type: "ALERT",
                message: cause.message,
                data: {
                    tabId,
                    frameId,
                },
            }),
        );
    } finally {
        activeTasks.delete(tabId);
    }
}

wss.on("connection", (ws) => {
    console.log("Extension connected");

    ws.on("message", async (message) => {
        try {
            const payload = JSON.parse(message.toString());
            console.log(payload);

            switch (payload.type) {
                case "NEW_TASK":
                    await runFFmpeg(ws, payload.data);
                    break;

                default:
                    console.warn("Unknown message:", payload.type);
                    break;
            }
        } catch (err) {
            console.error("Invalid message:", err);
        }
    });

    ws.on("close", () => {
        console.log("Extension disconnected");
    });
});

console.log(`SegCut Server running on ws://127.0.0.1:${PORT}`);
