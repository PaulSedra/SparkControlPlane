import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pipelineRegistryApiPlugin } from './src/server/api/pipelineRegistryVitePlugin.ts';

export default defineConfig(() => {
    const sparkHistoryUrl = process.env.SPARK_HISTORY_URL?.trim() || undefined;
    const sparkConnectUrl = process.env.SPARK_CONNECT_URL?.trim();
    const aistorWebhookToken = process.env.AISTOR_WEBHOOK_TOKEN?.trim();
    const pipelinesDir = process.env.PIPELINES_DIR?.trim();

    if (pipelinesDir) {
        process.env.PIPELINES_DIR = pipelinesDir;
    }

    return {
        envDir: path.join(process.cwd(), '.vite-no-env-files'),
        plugins: [react(), pipelineRegistryApiPlugin({
            aistorWebhookToken,
            sparkConnectUrl,
        })],
        root: path.resolve(process.cwd(), 'src/web'),
        build: {
            emptyOutDir: true,
            outDir: path.resolve(process.cwd(), 'dist'),
        },
        server: sparkHistoryUrl == null ? undefined : {
            proxy: {
                '/spark-api': {
                    target: sparkHistoryUrl,
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/spark-api/, '/api/v1'),
                },
            },
        },
    };
});
