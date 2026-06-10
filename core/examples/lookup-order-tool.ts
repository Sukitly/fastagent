/**
 * 自定义 domain tool 的标准模式(ketchup 同款):你项目里的普通 TS 模块,
 * 实现 pi 的 `AgentTool` 接口,由装配代码显式 import + 注入。
 * 代码随项目部署(带依赖);声明式挂工具的标准轨道是 .mcp.json(MCP,未来)。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const lookupOrderTool: AgentTool = {
  name: "lookup_order",
  label: "Lookup order",
  description: "Look up an order by id (e.g. ORD-1234). Returns status and purchase date.",
  parameters: Type.Object({ orderId: Type.String({ description: "Order id like ORD-1234" }) }),
  async execute(_id, params) {
    const { orderId } = params as { orderId: string };
    // 真实项目里这里查你的 DB/API;demo 用假数据。
    const order = { orderId, status: "shipped", purchasedAt: "2026-05-20", item: "Pro plan (annual)" };
    return { content: [{ type: "text", text: JSON.stringify(order) }], details: order };
  },
};

export default lookupOrderTool;
