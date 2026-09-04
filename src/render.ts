import { MemoryFileSystem, WebPCodec, ZipFileSystem, type FileSystem as TransformFileSystem } from '@playcanvas/splat-transform';
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Color, Mat4, path, Quat, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { EquirectRenderer } from './equirect-renderer';
import { Events } from './events';
import type { NovelViewPanelState, NovelViewPose } from './novel-view';
import { encodePng } from './png-writer';
import { Scene } from './scene';
import { injectSphericalMetadata } from './spherical-metadata';
import { Splat } from './splat';
import { i18n } from './ui/localization';
import { buildVideoEncoderConfig, getVideoCodecType, VideoSettings } from './video-config';

const nullClr = new Color(0, 0, 0, 0);
const novelViewPoseTransform = new Mat4();
const novelViewPoseRotation = new Quat();
const novelViewPoseForward = new Vec3();

// Lookup maps for video output format and codec configuration
const FORMAT_CONFIG: Record<string, { create: (streaming: boolean) => Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat; extension: string }> = {
    mp4: { create: streaming => new Mp4OutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mp4' },
    webm: { create: () => new WebMOutputFormat(), extension: 'webm' },
    mov: { create: streaming => new MovOutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mov' },
    mkv: { create: () => new MkvOutputFormat(), extension: 'mkv' }
};

// backpressure high-water mark for the encoder queue and pending muxer writes
const MAX_QUEUE_SIZE = 5;

type ImageSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'png' | 'jpeg' | 'webp';
    quality?: number;           // 0..1, jpeg only
    projection?: 'standard' | 'equirect';
    levelHorizon?: boolean;
    convertCoordinates?: boolean;
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

const isInvalidFilenameChar = (char: string) => {
    return /[<>:"/\\|?*]/.test(char) || char.charCodeAt(0) < 32;
};

const sanitizeFilename = (filename: string) => {
    const sanitized = Array.from(filename, char => (isInvalidFilenameChar(char) ? '_' : char)).join('').trim();
    return sanitized.length > 0 ? sanitized : 'supersplat';
};

// extract a plain filename from url-style names (e.g. splats imported via ?load=)
const getImportedFilename = (filename: string) => {
    const trimmed = filename.split(/[?#]/)[0];

    if (trimmed.includes('://') || trimmed.startsWith('blob:')) {
        try {
            return path.getBasename(new URL(trimmed).pathname);
        } catch {
            // fall through to the raw filename below
        }
    }

    return path.getBasename(trimmed);
};

// sorting is submitted on the GPU immediately before each render
const sortSplatsAndWait = (_scene: Scene, _splats: Splat[]) => Promise.resolve();

const downloadFile = (data: ArrayBuffer | Uint8Array<ArrayBuffer>, filename: string, type = 'application/octet-stream') => {
    const blob = new Blob([data], { type });
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};

type RenderCamera = {
    id: number;
    img_name: string;
    timestamp: number;
    source_frame: number;
    width: number;
    height: number;
    projection: 'perspective' | 'orthographic' | 'equirectangular';
    position: number[];
    rotation: number[][];
    fx: number | null;
    fy: number | null;
    cx: number;
    cy: number;
    fov: number | null;
    ortho_height?: number;
};

// Serialize the camera-to-world transform and pixel-space intrinsics used by
// a rendered frame. Matrix values are emitted as rows for easy consumption.
const serializeRenderCamera = (
    scene: Scene,
    settings: VideoSettings,
    id: number,
    timestamp: number,
    sourceFrame: number,
    position?: Vec3,
    rotation?: Quat
): RenderCamera => {
    const camera = scene.camera;
    const transform = position && rotation ?
        new Mat4().setTRS(position, rotation, Vec3.ONE) :
        camera.mainCamera.getWorldTransform();
    const m = transform.data;
    const projection = settings.projection === 'equirect' ? 'equirectangular' : camera.ortho ? 'orthographic' : 'perspective';

    let fx: number | null = null;
    let fy: number | null = null;
    if (projection === 'perspective') {
        const focal = 0.5 * (camera.camera.horizontalFov ? settings.width : settings.height) /
            Math.tan(0.5 * camera.fov * Math.PI / 180);
        fx = focal;
        fy = focal;
    }

    return {
        id,
        img_name: id.toString().padStart(6, '0'),
        timestamp,
        source_frame: sourceFrame,
        width: settings.width,
        height: settings.height,
        projection,
        position: [m[12], m[13], m[14]],
        rotation: [
            [m[0], m[4], m[8]],
            [m[1], m[5], m[9]],
            [m[2], m[6], m[10]]
        ],
        fx,
        fy,
        cx: settings.width * 0.5,
        cy: settings.height * 0.5,
        fov: projection === 'perspective' ? camera.fov : null,
        ...(projection === 'orthographic' ? { ortho_height: camera.camera.orthoHeight } : {})
    };
};

const registerRenderEvents = (scene: Scene, events: Events) => {
    let webpCodec: WebPCodec;

    // default base filename for rendered output: the project document name if
    // set, otherwise the first visible splat's name
    const baseFilename = () => {
        const docName = events.invoke('doc.name');
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        const source = docName || (splats[0]?.name ?? 'supersplat');
        return sanitizeFilename(removeExtension(getImportedFilename(source)));
    };

    events.function('render.baseFilename', baseFilename);

    // largest render target dimension the device supports; used by the render
    // dialogs to disable resolutions the gpu cannot produce
    events.function('render.maxTextureSize', () => scene.graphicsDevice.maxTextureSize);

    // wait for postrender to fire
    const postRender = () => {
        return new Promise<boolean>((resolve, reject) => {
            const handle = scene.events.on('postrender', () => {
                handle.off();
                try {
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
        });
    };

    events.function('render.offscreen', async (width: number, height: number): Promise<Uint8Array> => {
        try {
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { mainTarget, workTarget } = scene.camera;

            scene.dataProcessor.copyRt(mainTarget, workTarget);

            // read the rendered frame. the read must be immediate: nothing
            // submits the shared command encoder outside the frame, so a
            // deferred read maps the staging buffer before the copy above has
            // run and returns zeros.
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

            // rows are read back top-down (0,0 at the top)
            return data;
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
            scene.forceRender = true;       // repaint the viewport with normal rendering
        }
    });

    events.function('render.image', async (imageSettings: ImageSettings, fileStream?: FileSystemWritableFileStream) => {
        events.fire('startSpinner');

        let equirect: EquirectRenderer | null = null;
        let savedFov = 0;
        let savedOrtho = false;

        try {
            const { width, height, transparentBg, showDebug, format, quality, projection, levelHorizon } = imageSettings;
            const is360 = projection === 'equirect';

            // in 360 mode the offscreen target is a square cube face; the
            // equirect target holds the output-sized frame
            const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
            scene.camera.renderOverlays = is360 ? false : showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            if (is360) {
                savedFov = scene.camera.fov;
                savedOrtho = scene.camera.ortho;
                equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                scene.camera.ortho = false;

                // snapshot the current camera pose. supersplat cameras never
                // roll, so with level horizon the capture frame is the
                // camera yaw, otherwise yaw and pitch
                const camPos = new Vec3().copy(scene.camera.position);
                const qCapture = new Quat();
                if (levelHorizon ?? true) {
                    qCapture.setFromEulerAngles(0, scene.camera.azim, 0);
                } else {
                    qCapture.copy(scene.camera.mainCamera.getRotation());
                }

                // all faces share direction-independent clipping planes so
                // near-plane culling cannot differ across a face boundary
                const boundRadius = scene.bound.halfExtents.length();
                const dist = new Vec3().sub2(scene.bound.center, camPos).length();
                const far = dist + boundRadius;
                const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);

                const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                const qWorld = new Quat();

                for (let face = 0; face < 6; face++) {
                    qWorld.mul2(qCapture, EquirectRenderer.faceRotations[face]);
                    scene.camera.setPoseOverride({ position: camPos, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });

                    // faces view different directions, so each render must
                    // wait for its own sort
                    await sortSplatsAndWait(scene, splats);

                    // render a frame and wait for it to finish
                    scene.forceRender = true;
                    await postRender();

                    scene.dataProcessor.copyRt(scene.camera.mainTarget, equirect.faceTargets[face]);
                }

                // project the faces to the equirect target and read back
                equirect.project();
                await equirect.read(data);
            } else {
                // render the next frame
                scene.forceRender = true;

                // for render to finish
                await postRender();

                const { mainTarget, workTarget } = scene.camera;

                scene.dataProcessor.copyRt(mainTarget, workTarget);

                // read the rendered frame (immediate: see render.offscreen)
                await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });
            }

            let bytes: Uint8Array<ArrayBuffer>;
            let extension: string;
            let mimeType: string;

            if (format === 'png') {
                bytes = await encodePng(data, width, height);
                extension = 'png';
                mimeType = 'image/png';
            } else if (format === 'jpeg') {
                // jpeg has no alpha channel and canvas encoding flattens
                // transparent pixels toward black, so force full opacity
                for (let i = 3; i < data.length; i += 4) {
                    data[i] = 255;
                }

                const imageData = new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height);
                let blob: Blob;
                if (typeof OffscreenCanvas !== 'undefined') {
                    const canvas = new OffscreenCanvas(width, height);
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.9 });
                } else {
                    // fallback for browsers without OffscreenCanvas
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d');
                    if (!context) {
                        throw new Error('failed to create 2d context');
                    }
                    context.putImageData(imageData, 0, 0);
                    blob = await new Promise<Blob>((resolve, reject) => {
                        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('failed to encode jpeg'))), 'image/jpeg', quality ?? 0.9);
                    });
                }
                bytes = new Uint8Array(await blob.arrayBuffer());
                extension = 'jpg';
                mimeType = 'image/jpeg';
            } else {
                // construct the webp codec
                if (!webpCodec) {
                    webpCodec = await WebPCodec.create();
                }

                bytes = webpCodec.encodeLosslessRGBA(data, width, height);
                extension = 'webp';
                mimeType = 'image/webp';
            }

            if (fileStream) {
                await fileStream.write(bytes);
                await fileStream.close();
            } else {
                downloadFile(bytes, `${baseFilename()}.${extension}`, mimeType);
            }

            return true;
        } catch (error) {
            // close the stream even on failure so the caller can remove the
            // empty file
            if (fileStream) {
                try {
                    await fileStream.close();
                } catch {
                    // stream already closed or errored
                }
            }

            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('panel.render.failed'),
                message: `'${error.message ?? error}'`
            });

            return false;
        } finally {
            if (equirect) {
                scene.camera.setPoseOverride(null);
                scene.camera.fov = savedFov;
                scene.camera.ortho = savedOrtho;
                equirect.destroy();
                equirect = null;
            }

            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);
            scene.forceRender = true;       // repaint the viewport with normal rendering

            events.fire('stopSpinner');
        }
    });

    events.function('render.novelViews', async (poses: NovelViewPose[], imageSettings: ImageSettings, panelState?: NovelViewPanelState | null) => {
        if (poses.length === 0 || poses.length > 10000) {
            return false;
        }

        let cancelled = false;
        const cancelHandler = events.on('progressCancel', () => {
            cancelled = true;
        });
        events.fire('progressStart', i18n.t('novel-view.rendering'), true);

        const {
            width, height, transparentBg, showDebug, format, quality, convertCoordinates
        } = imageSettings;
        const extension = format === 'jpeg' ? 'jpg' : format;
        const originalPose = events.invoke('camera.getPose');
        const cameras: any[] = [];
        let outputFs: TransformFileSystem;
        let zipFs: ZipFileSystem | null = null;
        let zipMemory: MemoryFileSystem | null = null;
        let offscreen = false;

        try {
            const showDirectoryPicker = (window as any).showDirectoryPicker;
            if (showDirectoryPicker) {
                const parent = await showDirectoryPicker({ id: 'SuperSplatNovelViewExport', mode: 'readwrite' });
                const directory = await parent.getDirectoryHandle('novel-views', { create: true });
                const firstEntry = await directory.values().next();
                if (!firstEntry.done) {
                    throw new Error(i18n.t('novel-view.output-not-empty'));
                }
                outputFs = {
                    mkdir: async () => {},
                    createWriter: (filename: string) => {
                        let bytesWritten = 0;
                        let stream: FileSystemWritableFileStream;
                        const ready = directory.getFileHandle(filename, { create: true })
                        .then((handle: FileSystemFileHandle) => handle.createWritable())
                        .then((value: FileSystemWritableFileStream) => {
                            stream = value;
                        });
                        return {
                            get bytesWritten() {
                                return bytesWritten;
                            },
                            async write(data: Uint8Array) {
                                await ready;
                                bytesWritten += data.byteLength;
                                await stream.write(data as unknown as ArrayBuffer);
                            },
                            async close() {
                                await ready;
                                await stream.close();
                            },
                            async abort() {
                                await ready;
                                await stream.abort();
                            }
                        };
                    }
                };
            } else {
                zipMemory = new MemoryFileSystem();
                const zipWriter = await zipMemory.createWriter('novel-views.zip');
                zipFs = new ZipFileSystem(zipWriter);
                outputFs = zipFs;
            }

            scene.camera.startOffscreenMode(width, height);
            offscreen = true;
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
            scene.camera.clearPass.setClearColor(transparentBg ? nullClr : events.invoke('bgClr'));
            scene.lockedRenderMode = true;

            const data = new Uint8Array(width * height * 4);
            // cancelled is changed asynchronously by the progress callback
            // eslint-disable-next-line no-unmodified-loop-condition
            for (let i = 0; i < poses.length && !cancelled; i++) {
                const pose = poses[i];
                if (pose.up) {
                    novelViewPoseForward.sub2(pose.target, pose.position).normalize();
                    scene.camera.fitClippingPlanes(pose.position, novelViewPoseForward);
                    novelViewPoseTransform.setLookAt(pose.position, pose.target, pose.up);
                    novelViewPoseRotation.setFromMat4(novelViewPoseTransform);
                    scene.camera.setPoseOverride({
                        position: pose.position,
                        rotation: novelViewPoseRotation,
                        fov: pose.fov,
                        near: scene.camera.near,
                        far: scene.camera.far
                    });
                } else {
                    scene.camera.setPoseOverride(null);
                    events.fire('camera.setPose', pose, 0);
                    scene.camera.onUpdate(0);
                }
                scene.lockedRender = true;
                await postRender();

                const { mainTarget, workTarget } = scene.camera;
                scene.dataProcessor.copyRt(mainTarget, workTarget);
                await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

                let bytes: Uint8Array<ArrayBuffer>;
                if (format === 'png') {
                    bytes = await encodePng(data, width, height);
                } else if (format === 'jpeg') {
                    for (let p = 3; p < data.length; p += 4) data[p] = 255;
                    const canvas = new OffscreenCanvas(width, height);
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('failed to create 2d context');
                    context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
                    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality ?? 0.9 });
                    bytes = new Uint8Array(await blob.arrayBuffer());
                } else {
                    if (!webpCodec) webpCodec = await WebPCodec.create();
                    bytes = webpCodec.encodeLosslessRGBA(data, width, height);
                }

                const imgName = `${i.toString().padStart(5, '0')}.${extension}`;
                const writer = await outputFs.createWriter(imgName);
                await writer.write(bytes);
                await writer.close();

                const world = scene.camera.mainCamera.getWorldTransform().data;
                const position = [world[12], world[13], world[14]];
                const c2w = [
                    [world[0], world[4], world[8]],
                    [world[1], world[5], world[9]],
                    [world[2], world[6], world[10]]
                ];
                const focal = 0.5 * (scene.camera.camera.horizontalFov ? width : height) /
                    Math.tan(0.5 * pose.fov * Math.PI / 180);
                const K = [[focal, 0, width * 0.5], [0, focal, height * 0.5], [0, 0, 1]];
                const novelView = panelState ? {
                    version: 1,
                    settings: panelState
                } : undefined;

                if (convertCoordinates) {
                    // R = diag(1,-1,-1) * transpose(camera-to-world rotation)
                    const R = [
                        [c2w[0][0], c2w[1][0], c2w[2][0]],
                        [-c2w[0][1], -c2w[1][1], -c2w[2][1]],
                        [-c2w[0][2], -c2w[1][2], -c2w[2][2]]
                    ];
                    const t = R.map(row => -(row[0] * position[0] + row[1] * position[1] + row[2] * position[2]));
                    cameras.push({
                        id: i,
                        img_name: imgName,
                        width,
                        height,
                        coordinate_system: 'opencv',
                        novel_view: novelView,
                        K,
                        R,
                        t
                    });
                } else {
                    cameras.push({
                        id: i,
                        img_name: imgName,
                        width,
                        height,
                        coordinate_system: 'playcanvas',
                        novel_view: novelView,
                        K,
                        position,
                        rotation: c2w
                    });
                }

                events.fire('progressUpdate', {
                    text: i18n.t('novel-view.rendering-view', { current: i + 1, total: poses.length }),
                    progress: 100 * (i + 1) / poses.length
                });
            }

            if (!cancelled) {
                const jsonWriter = await outputFs.createWriter('cameras.json');
                await jsonWriter.write(new TextEncoder().encode(`${JSON.stringify(cameras, null, 2)}\n`));
                await jsonWriter.close();
            }

            if (zipFs) {
                await zipFs.close();
                if (!cancelled) {
                    const zipData = zipMemory.results.get('novel-views.zip');
                    if (!zipData) throw new Error('failed to create novel-view archive');
                    downloadFile(new Uint8Array(zipData), `${baseFilename()}-novel-views.zip`, 'application/zip');
                }
            }
            return !cancelled;
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('panel.render.failed'),
                    message: `'${(error as any).message ?? error}'`
                });
            }
            return false;
        } finally {
            cancelHandler.off();
            if (offscreen) scene.camera.endOffscreenMode();
            scene.camera.setPoseOverride(null);
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);
            scene.lockedRenderMode = false;
            if (originalPose) events.fire('camera.setPose', originalPose, 0);
            scene.forceRender = true;
            events.fire('progressEnd');
        }
    });

    events.function('render.video', (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream) => {
        const renderImpl = async () => {
            events.fire('progressStart', i18n.t('panel.render.render-video'), true);

            let cancelled = false;
            const cancelHandler = events.on('progressCancel', () => {
                cancelled = true;
            });

            let encoder: VideoEncoder | null = null;
            let equirect: EquirectRenderer | null = null;
            let savedFov = 0;
            let savedOrtho = false;
            let output: Output | null = null;
            let muxerWrites = Promise.resolve();

            try {
                const { startFrame, endFrame, frameRate, width, height, bitrate, transparentBg, showDebug, exportCameras, format, codec: codecChoice, projection, levelHorizon } = videoSettings;

                const is360 = projection === 'equirect';

                // 360 mp4/mov exports have spherical metadata patched into the
                // finished buffer, so they render to memory with moov written
                // last (fastStart false) instead of streaming to disk
                const taggable = is360 && (format === 'mp4' || format === 'mov');

                const target = (fileStream && !taggable) ? new StreamTarget(fileStream) : new BufferTarget();

                // Configure output format and codec from lookup maps (default to mp4/h264)
                const formatConfig = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.mp4;
                const outputFormat = formatConfig.create(taggable || !!fileStream);
                const fileExtension = formatConfig.extension;

                const encoderConfig = buildVideoEncoderConfig(videoSettings);
                const codecType = getVideoCodecType(codecChoice);

                output = new Output({
                    format: outputFormat,
                    target
                });

                const videoSource = new EncodedVideoPacketSource(codecType);
                output.addVideoTrack(videoSource, {
                    rotation: 0,
                    frameRate
                });

                await output.start();

                let encoderError: Error | null = null;
                let muxerError: Error | null = null;
                let muxerQueueSize = 0;

                // helper to create and configure a VideoEncoder instance
                const createEncoder = () => {
                    encoderError = null;
                    const enc = new VideoEncoder({
                        output: (chunk, meta) => {
                            const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                            muxerQueueSize++;

                            // WebCodecs ignores a Promise returned by its output
                            // callback: awaiting the muxer here provides no
                            // backpressure, and a rejected write becomes an
                            // unhandled rejection that silently drops packets
                            // from the finished file. Chain the writes instead
                            // so failures surface via muxerError, muxerQueueSize
                            // drives backpressure in the encode loop, and every
                            // write has settled before output.finalize().
                            muxerWrites = muxerWrites
                            .then(async () => {
                                if (!muxerError) {
                                    await videoSource.add(encodedPacket, meta);
                                }
                            })
                            .catch((error) => {
                                muxerError = error instanceof Error ? error : new Error(String(error));
                            })
                            .finally(() => {
                                muxerQueueSize--;
                            });
                        },
                        error: (error) => {
                            encoderError = error;
                        }
                    });
                    enc.configure(encoderConfig);
                    return enc;
                };

                // fail fast on unsupported configurations (e.g. encoder
                // dimension limits) instead of erroring mid-render
                const support = await VideoEncoder.isConfigSupported(encoderConfig);
                if (!support.supported) {
                    throw new Error(`Unsupported video configuration (${codecChoice} @ ${width}x${height})`);
                }

                encoder = createEncoder();

                // in 360 mode the offscreen target is a square cube face; the
                // equirect target holds the output-sized frame
                const faceSize = Math.min(height, scene.graphicsDevice.maxTextureSize);

                // start rendering to offscreen buffer only
                scene.camera.startOffscreenMode(is360 ? faceSize : width, is360 ? faceSize : height);
                scene.camera.renderOverlays = is360 ? false : showDebug;
                scene.gizmoLayer.enabled = false;
                if (!transparentBg) {
                    scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
                }
                scene.lockedRenderMode = true;

                if (is360) {
                    savedFov = scene.camera.fov;
                    savedOrtho = scene.camera.ortho;
                    equirect = new EquirectRenderer(scene.graphicsDevice, faceSize, width, height);
                    scene.camera.ortho = false;
                }

                // cpu-side buffer to read pixels into
                const data = new Uint8Array(width * height * 4);

                // remember last camera position so we can skip sorting if the camera didn't move
                const last_pos = new Vec3(0, 0, 0);
                const last_forward = new Vec3(1, 0, 0);

                // helper to sort splats and wait for completion
                const sortAndWait = (splats: Splat[]) => sortSplatsAndWait(scene, splats);

                // prepare the frame for rendering, returns the newly loaded splat if any
                const prepareFrame = async (frameTime: number, skipSort = false): Promise<Splat | null> => {
                    // Fire timeline.time for camera animation interpolation
                    events.fire('timeline.time', frameTime);

                    // Wait for PLY sequence to load the frame if present
                    const newSplat = await events.invoke('plysequence.setFrameAsync', Math.floor(frameTime)) as Splat | null;

                    // manually update the camera so position and rotation are correct
                    scene.camera.onUpdate(0);

                    // 360 capture re-sorts per cube face, so skip sorting here
                    if (skipSort) {
                        return newSplat;
                    }

                    // If a new PLY was loaded, sort and wait for completion
                    if (newSplat) {
                        await sortAndWait([newSplat]);
                    } else {
                        // No new PLY - sort existing splats if camera moved
                        const pos = scene.camera.position;
                        const forward = scene.camera.forward;
                        if (!last_pos.equals(pos) || !last_forward.equals(forward)) {
                            last_pos.copy(pos);
                            last_forward.copy(forward);

                            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                            await sortAndWait(splats);
                        }
                    }

                    return newSplat;
                };

                // wrap and submit the pixels currently in the data buffer
                const encodeFrame = async (frameTime: number) => {
                    // construct the video frame
                    const videoFrame = new VideoFrame(data, {
                        format: 'RGBA',
                        codedWidth: width,
                        codedHeight: height,
                        timestamp: Math.floor(1e6 * frameTime),
                        duration: Math.floor(1e6 / frameRate)
                    });

                    // wait for encoder queue to drain if necessary (backpressure handling)
                    while (encoder.encodeQueueSize > MAX_QUEUE_SIZE) {
                        await new Promise<void>((resolve) => {
                            setTimeout(resolve, 1);
                        });
                    }
                    // muxerQueueSize is decremented by the write chain settling
                    // during the await
                    // eslint-disable-next-line no-unmodified-loop-condition
                    while (muxerQueueSize > MAX_QUEUE_SIZE) {
                        await muxerWrites;
                    }

                    // if the codec was reclaimed (e.g. browser backgrounded the tab),
                    // recreate the encoder and continue
                    let forceKeyFrame = false;
                    if (encoder.state === 'closed' && encoderError?.message?.includes('reclaimed')) {
                        encoder = createEncoder();
                        forceKeyFrame = true;
                    }

                    // check for non-recoverable encoder errors
                    if (encoderError || muxerError) {
                        videoFrame.close();
                        throw encoderError ?? muxerError;
                    }

                    encoder.encode(videoFrame, { keyFrame: forceKeyFrame });
                    videoFrame.close();
                };

                // capture the current video frame
                const captureFrame = async (frameTime: number) => {
                    const { mainTarget, workTarget } = scene.camera;

                    scene.dataProcessor.copyRt(mainTarget, workTarget);

                    // read the rendered frame (immediate: see render.offscreen)
                    await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data, immediate: true });

                    await encodeFrame(frameTime);
                };

                const animFrameRate = events.invoke('timeline.frameRate');
                const duration = (endFrame - startFrame) / animFrameRate;
                const totalFrames = Math.floor(duration * frameRate) + 1;
                const renderCameras: RenderCamera[] = [];

                // work objects for 360 capture
                const camPos = new Vec3();
                const vec = new Vec3();
                const qCapture = new Quat();
                const qWorld = new Quat();

                // capture a 360 frame: render the six cube faces from the
                // animated camera position, re-sorting splats per face
                // direction, then project to equirect and encode
                const capture360 = async (frameTime: number) => {
                    // snapshot the animated camera pose. supersplat cameras
                    // never roll, so with level horizon the capture frame is
                    // the camera yaw, otherwise yaw and pitch
                    camPos.copy(scene.camera.position);
                    if (levelHorizon ?? true) {
                        qCapture.setFromEulerAngles(0, scene.camera.azim, 0);
                    } else {
                        qCapture.copy(scene.camera.mainCamera.getRotation());
                    }

                    // all faces share direction-independent clipping planes so
                    // near-plane culling cannot differ across a face boundary
                    const boundRadius = scene.bound.halfExtents.length();
                    const dist = vec.sub2(scene.bound.center, camPos).length();
                    const far = dist + boundRadius;
                    const near = Math.max(1e-6, dist < boundRadius ? far / (1024 * 16) : dist - boundRadius);

                    const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);

                    for (let face = 0; face < 6; face++) {
                        // check for cancellation
                        if (cancelled) return;

                        qWorld.mul2(qCapture, EquirectRenderer.faceRotations[face]);
                        scene.camera.setPoseOverride({ position: camPos, rotation: qWorld, fov: EquirectRenderer.faceFov, near, far });

                        // faces view different directions, so each render must
                        // wait for its own sort
                        await sortAndWait(splats);

                        // render a frame
                        scene.lockedRender = true;

                        // wait for render to finish
                        await postRender();

                        scene.dataProcessor.copyRt(scene.camera.mainTarget, equirect.faceTargets[face]);

                        const frameIndex = Math.round(frameTime * frameRate);
                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * (frameIndex + (face + 1) / 6) / totalFrames
                        });
                    }

                    // project the faces to the equirect target and encode
                    equirect.project();
                    await equirect.read(data);
                    await encodeFrame(frameTime);
                };

                for (let frameTime = 0; frameTime <= duration; frameTime += 1.0 / frameRate) {
                    // check for cancellation
                    if (cancelled) break;

                    if (is360) {
                        // restore animated-pose evaluation before the timeline
                        // advances (fov feeds the tween-to-position mapping)
                        scene.camera.setPoseOverride(null);
                        scene.camera.fov = savedFov;

                        // prepare the frame (loads PLY if needed, updates camera)
                        await prepareFrame(startFrame + frameTime * animFrameRate, true);

                        if (exportCameras) {
                            const position = scene.camera.position.clone();
                            const rotation = (levelHorizon ?? true) ?
                                new Quat().setFromEulerAngles(0, scene.camera.azim, 0) :
                                scene.camera.mainCamera.getRotation().clone();
                            renderCameras.push(serializeRenderCamera(
                                scene,
                                videoSettings,
                                renderCameras.length,
                                frameTime,
                                startFrame + frameTime * animFrameRate,
                                position,
                                rotation
                            ));
                        }

                        await capture360(frameTime);
                    } else {
                        // prepare the frame (loads PLY if needed, updates camera, sorts)
                        await prepareFrame(startFrame + frameTime * animFrameRate);

                        if (exportCameras) {
                            renderCameras.push(serializeRenderCamera(
                                scene,
                                videoSettings,
                                renderCameras.length,
                                frameTime,
                                startFrame + frameTime * animFrameRate
                            ));
                        }

                        // render a frame
                        scene.lockedRender = true;

                        // wait for render to finish
                        await postRender();

                        // wait for capture
                        await captureFrame(frameTime);

                        events.fire('progressUpdate', {
                            text: i18n.t('panel.render.rendering', { ellipsis: true }),
                            progress: 100 * frameTime / duration
                        });
                    }
                }

                // Flush and finalize output
                await encoder.flush();
                await muxerWrites;
                if (muxerError) {
                    throw muxerError;
                }
                await output.finalize();

                const filename = () => `${baseFilename()}.${fileExtension}`;

                if (taggable) {
                    // patch spherical metadata into the finished buffer so
                    // players auto-detect the equirectangular projection
                    if (!cancelled) {
                        let buffer = (target as BufferTarget).buffer;
                        try {
                            buffer = injectSphericalMetadata(buffer);
                        } catch (error) {
                            console.warn(`failed to inject spherical metadata: ${error.message ?? error}`);
                        }

                        if (fileStream) {
                            await fileStream.write(buffer);
                        } else {
                            downloadFile(buffer, filename());
                        }
                    }

                    // close the stream even when cancelled so the caller can
                    // remove the empty file
                    if (fileStream) {
                        await fileStream.close();
                    }
                } else if (!cancelled && !fileStream) {
                    // Download (skip if cancelled -- the caller will delete the file)
                    downloadFile((target as BufferTarget).buffer, filename());
                }

                if (!cancelled && exportCameras) {
                    const json = new TextEncoder().encode(`${JSON.stringify(renderCameras, null, 2)}\n`);
                    downloadFile(json, 'cameras.json', 'application/json');
                }

                return !cancelled;
            } catch (error) {
                // stop the encoder so no further packets are queued while
                // cleaning up
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }

                // the output's stream target holds a writer lock on the
                // destination file stream. drain in-flight muxer writes and
                // cancel the output to release it, otherwise the caller
                // cannot remove the partial file
                if (output) {
                    try {
                        await muxerWrites;
                        await output.cancel();
                    } catch {
                        // output already finalized or its target already closed
                    }
                }

                // tagged 360 exports write to the file stream directly, so
                // close it here too (mirrors render.image failure handling)
                if (fileStream) {
                    try {
                        await fileStream.close();
                    } catch {
                        // stream already closed or still locked by the output
                    }
                }

                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('panel.render.failed'),
                    message: `'${(error as any).message ?? error}'`
                });
                return false;
            } finally {
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }
                cancelHandler.off();

                if (equirect) {
                    scene.camera.setPoseOverride(null);
                    scene.camera.fov = savedFov;
                    scene.camera.ortho = savedOrtho;
                    equirect.destroy();
                    equirect = null;
                }

                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.gizmoLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
                scene.forceRender = true;       // camera likely moved, finish with normal render

                events.fire('progressEnd');
            }
        };

        // Acquire a Web Lock during encoding to signal the browser that this tab is
        // actively working, which helps prevent aggressive background throttling and
        // codec reclamation.
        if (navigator.locks) {
            return navigator.locks.request('supersplat-video-render', renderImpl);
        }
        return renderImpl();
    });
};

export { ImageSettings, registerRenderEvents };
export type { VideoSettings } from './video-config';
