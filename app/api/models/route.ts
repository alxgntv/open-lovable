import { NextResponse } from 'next/server';
import { getGetBlockDefaultModel, listGetBlockModels } from '@/lib/ai/getblock';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    console.log('[api/models] Loading GetBlock catalog');
    const models = await listGetBlockModels();
    const defaultModel = getGetBlockDefaultModel(models);
    console.log('[api/models] Returning models', { count: models.length, defaultModel });
    return NextResponse.json({
      success: true,
      defaultModel,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        supportedApis: model.supportedApis,
        maxCompletionTokens: model.maxCompletionTokens,
      })),
    });
  } catch (error) {
    console.error('[api/models] Failed to load GetBlock catalog:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load GetBlock models',
      models: [],
      defaultModel: '',
    }, { status: 500 });
  }
}
