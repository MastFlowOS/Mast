// The world-atlas package ships plain TopoJSON files with no type declarations.
declare module "world-atlas/countries-110m.json" {
  const topology: import("topojson-specification").Topology;
  export default topology;
}
