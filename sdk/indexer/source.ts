import { NearRpcOperationsSource } from "../operations.js";
import { Count } from "../validation.js";
import { FinalBlockSchema, type IndexSource } from "./types.js";
export class NearRpcIndexSource
  extends NearRpcOperationsSource
  implements IndexSource
{
  async blockAt(height: number) {
    Count.parse(height);
    const { hash, height: actual } = (
      await this.rpc("block", { block_id: height })
    ).header;
    return FinalBlockSchema.parse({ hash, height: actual });
  }
}
