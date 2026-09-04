import { BooleanInput, Button, Container, Label, NumericInput, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { generateNovelViews, GridOrder, importedNovelViewsFromCamerasJson, NovelViewPanelState, NovelViewPose, NovelViewSettings, NovelViewType } from '../novel-view';
import { Scene } from '../scene';
import { i18n } from '../ui/localization';
import arrowSvg from '../ui/svg/arrow.svg';
import collapseSvg from '../ui/svg/collapse.svg';

const createSvg = (svgString: string) => {
    const decoded = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decoded, 'image/svg+xml').documentElement;
};

class NovelViewTool {
    activate: () => void;
    deactivate: () => void;
    canDeactivate: () => boolean;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        let active = false;
        let rendering = false;
        let collapsed = false;
        let type: NovelViewType = 'line';
        let poses: NovelViewPose[] = [];
        let importedPoses: NovelViewPose[] = [];
        let importedSettings: NovelViewPanelState | null = null;

        const panel = new Container({
            class: ['novel-view-panel', 'blocks-shortcuts'],
            hidden: true
        });
        panel.dom.addEventListener('pointerdown', event => event.stopPropagation());

        const header = new Container({ class: 'novel-view-header' });
        const title = new Label({ class: 'novel-view-title' });
        let titleKey = 'novel-view.line';
        i18n.bindText(title, () => i18n.t(titleKey));
        const collapseButton = new Button({ class: 'novel-view-collapse' });
        collapseButton.dom.appendChild(createSvg(collapseSvg));
        collapseButton.dom.setAttribute('aria-label', i18n.t('novel-view.collapse'));
        header.append(title);
        header.append(collapseButton);
        panel.append(header);

        const controls = new Container({ class: 'novel-view-controls' });
        panel.append(controls);

        const row = (key: string, input: NumericInput) => {
            const container = new Container({ class: 'novel-view-row' });
            const label = new Label({ class: 'novel-view-label' });
            i18n.bindText(label, key);
            container.append(label);
            container.append(input);
            controls.append(container);
            return container;
        };

        const numberInput = (value: number, min: number, max: number, precision = 2) => new NumericInput({
            class: 'novel-view-input', value, min, max, precision
        });

        const countInput = numberInput(10, 1, 10000, 0);
        const offsetXInput = numberInput(0, -100000, 100000);
        const heightInput = numberInput(0, -100000, 100000);
        const offsetZInput = numberInput(0, -100000, 100000);
        const yawInput = numberInput(0, -180, 180, 1);
        const pitchInput = numberInput(0, -89, 89, 1);
        const fovInput = numberInput(60, 10, 120, 1);
        const radiusXInput = numberInput(1, 0.0001, 100000);
        const radiusZInput = numberInput(1, 0.0001, 100000);
        const widthInput = numberInput(1, 0, 100000);
        const lengthInput = numberInput(1, 0, 100000);
        const columnsInput = numberInput(5, 1, 10000, 0);
        const rowsInput = numberInput(5, 1, 10000, 0);
        const gridOrderInput = new SelectInput({
            class: 'novel-view-input',
            defaultValue: 'row-first'
        });
        i18n.bindOptions(gridOrderInput, () => [
            { v: 'row-first', t: i18n.t('novel-view.order.row-first') },
            { v: 'column-first', t: i18n.t('novel-view.order.column-first') }
        ]);

        const countRow = row('novel-view.view-count', countInput);
        const radiusXRow = row('novel-view.radius-x', radiusXInput);
        const radiusZRow = row('novel-view.radius-z', radiusZInput);
        const lockAspectRow = new Container({ class: 'novel-view-row' });
        const lockAspectLabel = new Label({ class: 'novel-view-label' });
        i18n.bindText(lockAspectLabel, 'novel-view.lock-aspect');
        const lockAspectInput = new BooleanInput({ type: 'toggle', value: true });
        lockAspectRow.append(lockAspectLabel);
        lockAspectRow.append(lockAspectInput);
        controls.append(lockAspectRow);
        const widthRow = row('novel-view.width', widthInput);
        const lengthRow = row('novel-view.length', lengthInput);
        const columnsRow = row('novel-view.columns', columnsInput);
        const rowsRow = row('novel-view.rows', rowsInput);
        const gridOrderRow = new Container({ class: 'novel-view-row' });
        const gridOrderLabel = new Label({ class: 'novel-view-label' });
        i18n.bindText(gridOrderLabel, 'novel-view.order');
        gridOrderRow.append(gridOrderLabel);
        gridOrderRow.append(gridOrderInput);
        controls.append(gridOrderRow);
        const offsetXRow = row('novel-view.offset-x', offsetXInput);
        const heightRow = row('novel-view.height', heightInput);
        const offsetZRow = row('novel-view.offset-z', offsetZInput);
        const yawRow = row('novel-view.yaw', yawInput);
        const pitchRow = row('novel-view.pitch', pitchInput);
        const fovRow = row('novel-view.fov', fovInput);

        const endpointRow = new Container({ class: 'novel-view-actions' });
        const startButton = new Button({ class: 'novel-view-button' });
        const endButton = new Button({ class: 'novel-view-button' });
        i18n.bindText(startButton, 'novel-view.set-start');
        i18n.bindText(endButton, 'novel-view.set-end');
        endpointRow.append(startButton);
        endpointRow.append(endButton);
        controls.append(endpointRow);

        const footer = new Container({ class: 'novel-view-actions' });
        const renderButton = new Button({ class: ['novel-view-button', 'primary'] });
        const exitButton = new Button({ class: 'novel-view-button' });
        i18n.bindText(renderButton, 'novel-view.render');
        i18n.bindText(exitButton, 'novel-view.exit');
        footer.append(renderButton);
        footer.append(exitButton);
        panel.append(footer);
        canvasContainer.append(panel);

        // Standalone restore control above the side toolbar. It deliberately
        // lives in the canvas container rather than inside either toolbar.
        const expandButton = new Button({
            class: 'novel-view-expand',
            hidden: true
        });
        expandButton.dom.appendChild(createSvg(arrowSvg));
        expandButton.dom.setAttribute('aria-label', i18n.t('novel-view.expand'));
        expandButton.dom.addEventListener('pointerdown', event => event.stopPropagation());
        canvasContainer.append(expandButton);

        const setCollapsed = (value: boolean) => {
            if (!active || collapsed === value) return;
            collapsed = value;
            panel.hidden = collapsed;
            expandButton.hidden = !collapsed;
            events.fire('novelView.panelCollapsed', collapsed);
        };

        collapseButton.dom.addEventListener('click', () => setCollapsed(true));
        expandButton.dom.addEventListener('click', () => setCollapsed(false));
        events.on('novelView.setPanelCollapsed', setCollapsed);

        let settings: NovelViewSettings;

        const panelState = (): NovelViewPanelState | null => {
            if (type === 'import') return null;
            return {
                ...settings,
                lockAspect: lockAspectInput.value
            };
        };

        let syncingAspect = false;
        const regenerate = (changedInput?: NumericInput) => {
            if (!active) return;
            if (type === 'import') {
                renderButton.enabled = poses.length > 0 && poses.length <= 10000;
                events.fire('novelView.changed', poses);
                scene.forceRender = true;
                return;
            }
            if (!syncingAspect && lockAspectInput.value && (changedInput === radiusXInput || changedInput === radiusZInput)) {
                syncingAspect = true;
                if (changedInput === radiusXInput) radiusZInput.value = radiusXInput.value;
                if (changedInput === radiusZInput) radiusXInput.value = radiusZInput.value;
                syncingAspect = false;
            }
            settings.count = countInput.value;
            settings.offsetX = offsetXInput.value;
            settings.height = heightInput.value;
            settings.offsetZ = offsetZInput.value;
            settings.yaw = yawInput.value;
            settings.pitch = pitchInput.value;
            settings.fov = fovInput.value;
            settings.radiusX = radiusXInput.value;
            settings.radiusZ = radiusZInput.value;
            settings.width = widthInput.value;
            settings.length = lengthInput.value;
            settings.columns = columnsInput.value;
            settings.rows = rowsInput.value;
            settings.gridOrder = gridOrderInput.value as GridOrder;
            poses = generateNovelViews(settings);
            const lineValid = type !== 'line' || settings.startX !== settings.endX || settings.startZ !== settings.endZ;
            const ovalValid = type !== 'oval' || settings.radiusX > 0 && settings.radiusZ > 0;
            const gridValid = type !== 'grid' ||
                (settings.columns === 1 || settings.width > 0) && (settings.rows === 1 || settings.length > 0);
            renderButton.enabled = poses.length <= 10000 && lineValid && ovalValid && gridValid;
            events.fire('novelView.changed', poses);
            scene.forceRender = true;
        };

        [countInput, offsetXInput, heightInput, offsetZInput, yawInput, pitchInput, fovInput, radiusXInput, radiusZInput,
            widthInput, lengthInput, columnsInput, rowsInput].forEach((input) => {
            input.on('change', () => regenerate(input));
        });

        lockAspectInput.on('change', () => regenerate(radiusXInput));
        gridOrderInput.on('change', () => regenerate());

        startButton.on('click', () => {
            const p = scene.camera.position;
            settings.startX = p.x;
            settings.startZ = p.z;
            regenerate();
        });

        endButton.on('click', () => {
            const p = scene.camera.position;
            settings.endX = p.x;
            settings.endZ = p.z;
            regenerate();
        });

        renderButton.on('click', async () => {
            if (rendering) return;
            const imageSettings = await events.invoke('show.novelViewImageSettings');
            if (!imageSettings || !active) return;
            rendering = true;
            renderButton.enabled = false;
            try {
                await events.invoke('render.novelViews', poses, imageSettings, panelState());
            } finally {
                rendering = false;
                renderButton.enabled = true;
            }
        });

        exitButton.on('click', () => events.fire('tool.deactivate'));

        events.on('novelView.setType', (value: NovelViewType) => {
            type = value;
            if (value !== 'import') {
                importedPoses = [];
                importedSettings = null;
            }
        });

        const importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = '.json,application/json';
        importInput.style.display = 'none';
        canvasContainer.dom.appendChild(importInput);

        importInput.addEventListener('change', async () => {
            const file = importInput.files?.[0];
            importInput.value = '';
            if (!file) return;

            try {
                const imported = importedNovelViewsFromCamerasJson(JSON.parse(await file.text()), scene.camera.fov);
                importedPoses = imported.poses;
                importedSettings = imported.settings;
                type = importedSettings?.type ?? 'import';
                events.fire('tool.novelView');
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('novel-view.import-failed'),
                    message: `'${(error as any).message ?? error}'`
                });
            }
        });

        events.on('novelView.importCameras', () => {
            importInput.click();
        });
        events.function('novelView.active', () => active);
        events.function('novelView.rendering', () => rendering);
        events.function('novelView.poses', () => poses);
        events.function('novelView.settings', () => (active ? panelState() : null));
        this.canDeactivate = () => !rendering;

        this.activate = () => {
            active = true;
            collapsed = false;
            events.fire('timeline.setPlaying', false);

            const p = scene.camera.position;
            settings = importedSettings ? {
                ...importedSettings
            } : {
                type,
                centerX: p.x,
                centerY: p.y,
                centerZ: p.z,
                offsetX: 0,
                height: 0,
                offsetZ: 0,
                yaw: 0,
                pitch: 0,
                fov: scene.camera.fov,
                count: type === 'oval' ? 36 : 10,
                startX: p.x - 0.5,
                startZ: p.z,
                endX: p.x + 0.5,
                endZ: p.z,
                radiusX: 1,
                radiusZ: 1,
                width: 1,
                length: 1,
                columns: 5,
                rows: 5,
                gridOrder: 'row-first'
            };

            countInput.value = settings.count;
            offsetXInput.value = settings.offsetX;
            heightInput.value = settings.height;
            offsetZInput.value = settings.offsetZ;
            yawInput.value = settings.yaw;
            pitchInput.value = settings.pitch;
            fovInput.value = settings.fov;
            radiusXInput.value = settings.radiusX;
            radiusZInput.value = settings.radiusZ;
            widthInput.value = settings.width;
            lengthInput.value = settings.length;
            columnsInput.value = settings.columns;
            rowsInput.value = settings.rows;
            gridOrderInput.value = settings.gridOrder;
            lockAspectInput.value = importedSettings?.lockAspect ?? true;

            const imported = type === 'import';
            countRow.hidden = imported || type === 'grid';
            offsetXRow.hidden = imported || type === 'line';
            heightRow.hidden = imported;
            offsetZRow.hidden = imported || type === 'line';
            yawRow.hidden = imported;
            pitchRow.hidden = imported;
            fovRow.hidden = imported;
            endpointRow.hidden = type !== 'line';
            radiusXRow.hidden = type !== 'oval';
            radiusZRow.hidden = type !== 'oval';
            lockAspectRow.hidden = type !== 'oval';
            widthRow.hidden = type !== 'grid';
            lengthRow.hidden = type !== 'grid';
            columnsRow.hidden = type !== 'grid';
            rowsRow.hidden = type !== 'grid';
            gridOrderRow.hidden = type !== 'grid';
            titleKey = `novel-view.${type}`;
            title.text = i18n.t(titleKey);

            panel.hidden = false;
            if (imported) {
                poses = importedPoses.map(pose => ({
                    position: pose.position.clone(),
                    target: pose.target.clone(),
                    fov: pose.fov,
                    up: pose.up?.clone()
                }));
                regenerate();
            } else {
                regenerate();
            }
            events.fire('novelView.active', true);
            events.fire('novelView.panelCollapsed', false);
        };

        this.deactivate = () => {
            if (rendering) return;
            active = false;
            poses = [];
            importedPoses = [];
            importedSettings = null;
            panel.hidden = true;
            expandButton.hidden = true;
            events.fire('novelView.active', false);
            events.fire('novelView.panelCollapsed', false);
            events.fire('novelView.changed', poses);
            scene.forceRender = true;
        };
    }
}

export { NovelViewTool };
