import * as Minecraft from '@minecraft/server';
import * as GameTest from '@minecraft/server-gametest';

globalThis.totalTicks = 0;
Minecraft.system.run(function handler() {
    globalThis.totalTicks += 1; // trigger debugger to response since quickjs does not provide a message loop
    Minecraft.system.run(handler);
});

GameTest.register('gametest', 'remote', (test) => {
    test.succeed();
    /* BREAKPOINT HERE */ console.error(`Current tick: ${globalThis.totalTicks}`);
});
