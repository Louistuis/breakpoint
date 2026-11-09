/**
 * Service locator shared by every system. Systems keep a reference to this object and
 * look their collaborators up at call time, which keeps construction order simple and
 * avoids import cycles (everything here is a type-only import).
 */
import type { IAudio } from '../audio/types';
import type { IHud } from '../ui/types';
import type { CollapseDirector } from '../destruction/CollapseDirector';
import type { DamageSystem } from '../destruction/DamageSystem';
import type { DebrisManager } from '../destruction/DebrisManager';
import type { ExplosionSystem } from '../destruction/ExplosionSystem';
import type { FireSystem } from '../destruction/FireSystem';
import type { StructuralIntegrity } from '../destruction/StructuralIntegrity';
import type { VoxelGrid } from '../destruction/VoxelGrid';
import type { InteractionSystem } from '../gameplay/InteractionSystem';
import type { ObjectiveSystem } from '../gameplay/ObjectiveSystem';
import type { PlayerController } from '../gameplay/PlayerController';
import type { WeaponManager } from '../gameplay/WeaponManager';
import type { GameMode } from '../gameplay/challenges';
import type { CameraRig } from './Camera';
import type { Input } from './Input';
import type { Particles } from './Particles';
import type { PerformanceManager } from './PerformanceManager';
import type { Physics } from './Physics';
import type { Renderer } from './Renderer';
import type { World } from './World';

export interface GameContext {
  renderer: Renderer;
  physics: Physics;
  world: World;
  grid: VoxelGrid;
  particles: Particles;
  audio: IAudio;
  hud: IHud;
  camera: CameraRig;
  input: Input;
  perf: PerformanceManager;
  integrity: StructuralIntegrity;
  damage: DamageSystem;
  collapse: CollapseDirector;
  debris: DebrisManager;
  explosions: ExplosionSystem;
  fire: FireSystem;
  player: PlayerController;
  weapons: WeaponManager;
  interaction: InteractionSystem;
  objectives: ObjectiveSystem;
  mode: GameMode;
  /** Seconds of simulated play time since the environment was last (re)built. */
  time: number;
}
