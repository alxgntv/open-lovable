import { NextResponse } from 'next/server';

declare global {
  var activeSandbox: any;
  var activeSandboxProvider: any;
  var lastViteRestartTime: number;
  var viteRestartInProgress: boolean;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { recover?: boolean };
    const provider = global.activeSandbox || global.activeSandboxProvider;
    
    if (!provider) {
      return NextResponse.json({ 
        success: false, 
        error: 'No active sandbox' 
      }, { status: 400 });
    }
    
    if (global.viteRestartInProgress) {
      console.log('[restart-vite] Vite start already in progress, waiting...');
      return NextResponse.json({
        success: true,
        message: 'Vite start already in progress'
      });
    }

    global.viteRestartInProgress = true;
    
    console.log('[restart-vite] Using provider method to restart Vite', { recover: body.recover === true });

    if (body.recover === true && typeof provider.recoverDeadVite === 'function') {
      await provider.recoverDeadVite();
      console.log('[restart-vite] Dead Vite process replaced');
    } else if (typeof provider.restartViteServer === 'function') {
      await provider.restartViteServer();
      console.log('[restart-vite] Vite restarted via provider method');
    } else {
      // Fallback to manual restart using provider's runCommand
      console.log('[restart-vite] Fallback to manual Vite restart...');
      
      // Kill existing Vite processes
      try {
        await provider.runCommand('pkill -f vite');
        console.log('[restart-vite] Killed existing Vite processes');
        
        // Wait a moment for processes to terminate
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        console.log('[restart-vite] No existing Vite processes found');
      }
      
      // Clear any error tracking files
      try {
        await provider.runCommand('bash -c "echo \'{\\"errors\\": [], \\"lastChecked\\": '+ Date.now() +'}\' > /tmp/vite-errors.json"');
      } catch {
        // Ignore if this fails
      }
      
      // Start Vite dev server in background
      await provider.runCommand('sh -c "nohup npm run dev > /tmp/vite.log 2>&1 &"');
      console.log('[restart-vite] Vite dev server restarted');
      
      // Wait for Vite to start up
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Update global state
    global.lastViteRestartTime = Date.now();
    global.viteRestartInProgress = false;
    
    return NextResponse.json({
      success: true,
      message: 'Vite restarted successfully'
    });
    
  } catch (error) {
    console.error('[restart-vite] Error:', error);
    
    // Clear the restart flag on error
    global.viteRestartInProgress = false;
    
    return NextResponse.json({ 
      success: false, 
      error: (error as Error).message 
    }, { status: 500 });
  }
}