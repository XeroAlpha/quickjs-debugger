import * as Minecraft from "mojang-minecraft";
import * as GameTest from "mojang-gametest";

let totalTicks = 0;
Minecraft.world.events.tick.subscribe(() => {
    totalTicks += 1; // trigger debugger to response since quickjs does not provide a message loop
    (() => {})(Minecraft, totalTicks);
});

GameTest.register("gametest", "remote", (test) => {
    test.succeed();
    /* BREAKPOINT HERE */ (() => {})(test, Minecraft, totalTicks);
});
