import "./kit/sandbox"; // first: no network for scene / PR code during the render
import "./index.css";
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
