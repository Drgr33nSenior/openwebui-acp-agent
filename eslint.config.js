import ts from "typescript-eslint";
export default ts.config(...ts.configs.recommended, {
  rules: { "@typescript-eslint/no-explicit-any": "off" },
});
