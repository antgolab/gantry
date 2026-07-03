export const GANTRY_DIR = '.gantry';
export const PLANNING_DIR = `${GANTRY_DIR}/planning`;
export const SPECS_DIR = `${GANTRY_DIR}/specs`;
export const CORE_DIR = `${GANTRY_DIR}/core`;
// phase 源文件安装后所在目录(本地安装时由 install 拷贝到此处)。
// context-pack 为用户项目生成路径,必须指向这里,而非开发仓根目录的 phases/。
export const PHASES_DIR = `${CORE_DIR}/phases`;

export function specsPath(...parts) {
  return [SPECS_DIR, ...parts].join('/');
}
