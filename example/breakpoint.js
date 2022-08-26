/* global Minecraft */
const assert = require("assert").strict;
const net = require("net");
const { QuickJSDebugProtocol, QuickJSDebugSession } = require("../lib");

function main([port]) {
    const server = net.createServer(async (socket) => {
        const protocol = new QuickJSDebugProtocol(socket);
        const session = new QuickJSDebugSession(protocol);
        session.setBreakpoints("scripts/main.js", [12]);
        session.resume();
        session.on("stopped", async (ev) => {
            if (ev.reason === "breakpoint") {
                const topStack = await session.getTopStack();
                assert.equal(topStack.fileName, "scripts/main.js");
                assert.equal(topStack.lineNumber, 12);
                const result = await topStack.evaluate(({ blockId }) => {
                    const blockType = Minecraft.MinecraftBlockTypes[blockId];
                    const permutation = blockType.createDefaultBlockPermutation();
                    return permutation.getTags();
                }, { blockId: "cobblestone" });
                assert.deepEqual(result, ["stone"]);
                process.stdout.write(await topStack.evaluate(() => {
                    const player = [...Minecraft.world.getPlayers()][0];
                    const { location } = player;
                    return `${player.name}(${location.x},${location.y},${location.z})`;
                }));
                process.stdout.write("\n");
                await session.continue();
                protocol.close();
                server.close();
            }
        });
    });
    server.listen(port);
    process.stdout.write(`Please type '/script debugger connect <host>:${server.address().port}' in Minecraft\n`);
}

main(process.argv.slice(2));
