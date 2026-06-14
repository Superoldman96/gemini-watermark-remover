const ALLENK_FDNCNN_RUNTIME_PROFILES = Object.freeze([
    Object.freeze({
        id: 'allenk-fdncnn-104',
        modelSize: 104,
        maxWatermarkSize: 56,
        modelUrl: './models/allenk-fdncnn/model_core_fp32_104.onnx',
        inputShape: Object.freeze([1, 4, 104, 104]),
        outputShape: Object.freeze([1, 3, 104, 104])
    }),
    Object.freeze({
        id: 'allenk-fdncnn-200',
        modelSize: 200,
        maxWatermarkSize: Infinity,
        modelUrl: './models/allenk-fdncnn/model_core_fp32_200.onnx',
        inputShape: Object.freeze([1, 4, 200, 200]),
        outputShape: Object.freeze([1, 3, 200, 200])
    })
]);

const DEFAULT_ALLENK_FDNCNN_RUNTIME_PROFILE = ALLENK_FDNCNN_RUNTIME_PROFILES[1];
const DEFAULT_ALLENK_FDNCNN_PADDING = 64;

function getWatermarkSize(position = null) {
    const width = Number(position?.width);
    const height = Number(position?.height ?? position?.width);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return Math.max(width, height);
}

function cloneAllenkProfile(profile, padding) {
    return {
        ...profile,
        inputShape: [...profile.inputShape],
        outputShape: [...profile.outputShape],
        padding
    };
}

function resolveAllenkFdncnnRuntimeProfile(position = null) {
    const watermarkSize = getWatermarkSize(position);
    if (!watermarkSize) {
        return cloneAllenkProfile(DEFAULT_ALLENK_FDNCNN_RUNTIME_PROFILE, DEFAULT_ALLENK_FDNCNN_PADDING);
    }

    const profile = ALLENK_FDNCNN_RUNTIME_PROFILES.find((candidate) => watermarkSize <= candidate.maxWatermarkSize) ||
        DEFAULT_ALLENK_FDNCNN_RUNTIME_PROFILE;
    const padding = Math.max(0, Math.floor((profile.modelSize - watermarkSize) / 2));
    return cloneAllenkProfile(profile, padding);
}

export {
    ALLENK_FDNCNN_RUNTIME_PROFILES,
    resolveAllenkFdncnnRuntimeProfile
};
