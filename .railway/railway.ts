import { defineRailway, project, service } from "railway/iac";
export default defineRailway(() => {
  const round_hunter = service("round-hunter", {
    builder: "DOCKERFILE"
  });
  return project("empowering-abundance", {
    resources: [round_hunter],
  });
});
