import { hashWebPassword, verifyWebPassword } from "../../worker/src/auth";

export default {
  async fetch() {
    const stored = await hashWebPassword("probe-password");
    const verified = await verifyWebPassword("probe-password", stored);
    const rejected = await verifyWebPassword("wrong-password", stored);
    return Response.json({ stored, verified, rejected });
  },
};
