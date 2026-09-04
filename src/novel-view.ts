import { Vec3 } from 'playcanvas';

type NovelViewType = 'line' | 'oval' | 'grid' | 'import';
type GridOrder = 'row-first' | 'column-first';

type NovelViewPose = {
    position: Vec3;
    target: Vec3;
    fov: number;
    up?: Vec3;
};

type NovelViewSettings = {
    type: NovelViewType;
    centerX: number;
    centerY: number;
    centerZ: number;
    offsetX: number;
    height: number; // offset from the camera Y captured when the tool opens
    offsetZ: number;
    yaw: number;
    pitch: number;
    fov: number;
    count: number;
    startX: number;
    startZ: number;
    endX: number;
    endZ: number;
    radiusX: number;
    radiusZ: number;
    width: number;
    length: number;
    columns: number;
    rows: number;
    gridOrder: GridOrder;
};

type NovelViewPanelState = NovelViewSettings & {
    lockAspect: boolean;
};

type ImportedNovelViews = {
    poses: NovelViewPose[];
    settings: NovelViewPanelState | null;
};

type Mat3Rows = [[number, number, number], [number, number, number], [number, number, number]];

const rotateAroundAxis = (vector: Vec3, axis: Vec3, angle: number) => {
    const radians = angle * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dot = axis.dot(vector);
    return new Vec3(
        vector.x * cos + (axis.y * vector.z - axis.z * vector.y) * sin + axis.x * dot * (1 - cos),
        vector.y * cos + (axis.z * vector.x - axis.x * vector.z) * sin + axis.y * dot * (1 - cos),
        vector.z * cos + (axis.x * vector.y - axis.y * vector.x) * sin + axis.z * dot * (1 - cos)
    );
};

const orientationForPose = (settings: NovelViewSettings, position: Vec3) => {
    if (settings.type === 'oval') {
        // Oval cameras face inward by default. Yaw and pitch are offsets from
        // that radial direction, rather than absolute world angles.
        const direction = new Vec3(
            settings.centerX + settings.offsetX - position.x,
            0,
            settings.centerZ + settings.offsetZ - position.z
        ).normalize();
        const yawedDirection = rotateAroundAxis(direction, Vec3.UP, settings.yaw).normalize();
        const right = new Vec3().cross(yawedDirection, Vec3.UP).normalize();
        return {
            forward: rotateAroundAxis(yawedDirection, right, settings.pitch).normalize(),
            up: rotateAroundAxis(Vec3.UP, right, settings.pitch).normalize()
        };
    }

    // Line and grid cameras face world -Y by default. At pitch 0, yaw is a
    // roll around the view direction, so carry it in the up vector.
    const up = rotateAroundAxis(Vec3.BACK, Vec3.DOWN, settings.yaw).normalize();
    const right = new Vec3().cross(Vec3.DOWN, up).normalize();
    return {
        forward: rotateAroundAxis(Vec3.DOWN, right, settings.pitch).normalize(),
        up: rotateAroundAxis(up, right, settings.pitch).normalize()
    };
};

const generateNovelViews = (settings: NovelViewSettings): NovelViewPose[] => {
    const positions: Vec3[] = [];
    const y = settings.centerY + settings.height;

    if (settings.type === 'line') {
        const count = Math.max(1, Math.round(settings.count));
        for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0.5 : i / (count - 1);
            positions.push(new Vec3(
                settings.startX + (settings.endX - settings.startX) * t,
                y,
                settings.startZ + (settings.endZ - settings.startZ) * t
            ));
        }
    } else if (settings.type === 'oval') {
        const count = Math.max(1, Math.round(settings.count));
        for (let i = 0; i < count; i++) {
            const theta = 2 * Math.PI * i / count;
            positions.push(new Vec3(
                settings.centerX + settings.offsetX + settings.radiusX * Math.cos(theta),
                y,
                settings.centerZ + settings.offsetZ + settings.radiusZ * Math.sin(theta)
            ));
        }
    } else if (settings.type === 'grid') {
        const columns = Math.max(1, Math.round(settings.columns));
        const rows = Math.max(1, Math.round(settings.rows));
        const addPosition = (row: number, column: number) => {
            const tz = rows === 1 ? 0.5 : row / (rows - 1);
            const z = settings.centerZ + settings.offsetZ - settings.length * 0.5 + settings.length * tz;
            const tx = columns === 1 ? 0.5 : column / (columns - 1);
            const x = settings.centerX + settings.offsetX - settings.width * 0.5 + settings.width * tx;
            positions.push(new Vec3(x, y, z));
        };

        if (settings.gridOrder === 'column-first') {
            for (let column = 0; column < columns; column++) {
                for (let row = 0; row < rows; row++) {
                    addPosition(row, column);
                }
            }
        } else {
            for (let row = 0; row < rows; row++) {
                for (let column = 0; column < columns; column++) {
                    addPosition(row, column);
                }
            }
        }
    } else {
        return [];
    }

    return positions.map((position) => {
        const { forward, up } = orientationForPose(settings, position);
        return {
            position,
            target: position.clone().add(forward),
            fov: settings.fov,
            up
        };
    });
};

const finiteNumber = (value: unknown) => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const finiteNumberOr = (value: unknown, fallback: number) => {
    const parsed = finiteNumber(value);
    return parsed === null ? fallback : parsed;
};

const parseVec3 = (value: unknown) => {
    if (!Array.isArray(value) || value.length < 3) return null;
    const x = finiteNumber(value[0]);
    const y = finiteNumber(value[1]);
    const z = finiteNumber(value[2]);
    return x === null || y === null || z === null ? null : new Vec3(x, y, z);
};

const parseMat3Rows = (value: unknown): Mat3Rows | null => {
    if (!Array.isArray(value) || value.length < 3) return null;
    const rows = value.slice(0, 3).map((row) => {
        if (!Array.isArray(row) || row.length < 3) return null;
        const values = row.slice(0, 3).map(finiteNumber);
        return values.some(v => v === null) ? null : values as [number, number, number];
    });
    return rows.some(row => row === null) ? null : rows as Mat3Rows;
};

const fovFromCamera = (camera: any, fallbackFov: number) => {
    const directFov = finiteNumber(camera.fov);
    if (directFov !== null) return directFov;

    const height = finiteNumber(camera.height);
    const k = parseMat3Rows(camera.K);
    const fy = k ? k[1][1] : finiteNumber(camera.fy);
    if (height !== null && fy !== null && fy > 0) {
        return 2 * Math.atan(height * 0.5 / fy) * 180 / Math.PI;
    }

    return fallbackFov;
};

const poseFromCameraToWorld = (position: Vec3, c2w: Mat3Rows, fov: number): NovelViewPose => {
    // PlayCanvas cameras look down local -Z, while the matrix stores local +Z.
    const target = new Vec3(
        position.x - c2w[0][2],
        position.y - c2w[1][2],
        position.z - c2w[2][2]
    );
    const up = new Vec3(c2w[0][1], c2w[1][1], c2w[2][1]).normalize();
    return { position, target, fov, up };
};

const isGeneratedType = (value: unknown): value is 'line' | 'oval' | 'grid' => {
    return value === 'line' || value === 'oval' || value === 'grid';
};

const parsePanelState = (value: unknown): NovelViewPanelState | null => {
    const raw = (value as any)?.settings ?? value as any;
    if (!raw || !isGeneratedType(raw.type)) return null;

    return {
        type: raw.type,
        centerX: finiteNumberOr(raw.centerX, 0),
        centerY: finiteNumberOr(raw.centerY, 0),
        centerZ: finiteNumberOr(raw.centerZ, 0),
        offsetX: finiteNumberOr(raw.offsetX, 0),
        height: finiteNumberOr(raw.height, 0),
        offsetZ: finiteNumberOr(raw.offsetZ, 0),
        yaw: finiteNumberOr(raw.yaw, 0),
        pitch: finiteNumberOr(raw.pitch, 0),
        fov: finiteNumberOr(raw.fov, 60),
        count: finiteNumberOr(raw.count, 10),
        startX: finiteNumberOr(raw.startX, 0),
        startZ: finiteNumberOr(raw.startZ, 0),
        endX: finiteNumberOr(raw.endX, 0),
        endZ: finiteNumberOr(raw.endZ, 0),
        radiusX: finiteNumberOr(raw.radiusX, 1),
        radiusZ: finiteNumberOr(raw.radiusZ, 1),
        width: finiteNumberOr(raw.width, 1),
        length: finiteNumberOr(raw.length, 1),
        columns: finiteNumberOr(raw.columns, 5),
        rows: finiteNumberOr(raw.rows, 5),
        gridOrder: raw.gridOrder === 'column-first' ? 'column-first' : 'row-first',
        lockAspect: raw.lockAspect !== false
    };
};

const importedNovelViewsFromCamerasJson = (json: unknown, fallbackFov: number): ImportedNovelViews => {
    const cameras = Array.isArray(json) ? json : (json as any)?.cameras;
    if (!Array.isArray(cameras) || cameras.length === 0 || cameras.length > 10000) {
        throw new Error('cameras.json must contain between 1 and 10000 cameras.');
    }

    const settings = parsePanelState((json as any)?.novel_view) ?? parsePanelState(cameras[0]?.novel_view);
    const poses = cameras.map((camera: any, index: number) => {
        const fov = fovFromCamera(camera, fallbackFov);
        const target = parseVec3(camera.target);
        const position = parseVec3(camera.position);
        if (position && target) {
            return { position, target, fov, up: parseVec3(camera.up) ?? undefined };
        }

        const c2w = parseMat3Rows(camera.rotation);
        if (position && c2w) {
            return poseFromCameraToWorld(position, c2w, fov);
        }

        const r = parseMat3Rows(camera.R);
        const t = parseVec3(camera.t);
        if (r && t) {
            const opencvPosition = new Vec3(
                -(r[0][0] * t.x + r[1][0] * t.y + r[2][0] * t.z),
                -(r[0][1] * t.x + r[1][1] * t.y + r[2][1] * t.z),
                -(r[0][2] * t.x + r[1][2] * t.y + r[2][2] * t.z)
            );
            const opencvC2w: Mat3Rows = [
                [r[0][0], -r[1][0], -r[2][0]],
                [r[0][1], -r[1][1], -r[2][1]],
                [r[0][2], -r[1][2], -r[2][2]]
            ];
            return poseFromCameraToWorld(opencvPosition, opencvC2w, fov);
        }

        throw new Error(`Camera ${index} is missing supported pose fields.`);
    });

    return { poses, settings };
};

export { generateNovelViews, importedNovelViewsFromCamerasJson };
export type { GridOrder, ImportedNovelViews, NovelViewPanelState, NovelViewPose, NovelViewSettings, NovelViewType };
