/** Game-mode and Destruction Challenge definitions (pure data, shared by gameplay and UI). */
export type GameMode = 'sandbox' | 'challenge';

export type WeaponId = 'hammer' | 'pistol' | 'shotgun' | 'charge' | 'rocket' | 'torch';

export interface ChallengeDef {
  id: string;
  /** Short contract code shown as a tag, e.g. "C-01". */
  code: string;
  title: string;
  /** One or two sentences of briefing. */
  brief: string;
  /** Human name of the target structure. */
  targetName: string;
  /** Key of the structure region produced by the world generator. */
  targetKey: 'residential' | 'gasstation' | 'construction' | 'warehouse';
  /** Seconds. */
  timeLimit: number;
  /** Fraction (0..1) of the target that must be destroyed to pass. */
  targetFraction: number;
  /** Ammunition granted. null = unlimited. */
  loadout: { charges: number | null; rockets: number | null; shells: number | null; rounds: number | null };
  difficulty: 1 | 2 | 3;
}

export const CHALLENGES: ChallengeDef[] = [
  {
    id: 'residential',
    code: 'C-01',
    title: 'Notice to Vacate',
    brief: 'The condemned house on Mill Lane has to come down before the shift ends. Take out what holds it up and let gravity do the rest.',
    targetName: 'No. 4 Mill Lane',
    targetKey: 'residential',
    timeLimit: 180,
    targetFraction: 0.6,
    loadout: { charges: 8, rockets: 4, shells: 30, rounds: 60 },
    difficulty: 1,
  },
  {
    id: 'gasstation',
    code: 'C-02',
    title: 'Last Fill-Up',
    brief: 'Clear the old fuel station. The tanks were never drained, so one spark in the right place is worth a crate of explosives.',
    targetName: 'Kestrel Fuel Station',
    targetKey: 'gasstation',
    timeLimit: 120,
    targetFraction: 0.65,
    loadout: { charges: 4, rockets: 3, shells: 24, rounds: 48 },
    difficulty: 2,
  },
  {
    id: 'construction',
    code: 'C-03',
    title: 'Stop Work Order',
    brief: 'The unfinished frame on Lot 9 failed inspection. Drop the concrete skeleton with as few charges as you can.',
    targetName: 'Lot 9 Frame',
    targetKey: 'construction',
    timeLimit: 240,
    targetFraction: 0.55,
    loadout: { charges: 10, rockets: 6, shells: 30, rounds: 60 },
    difficulty: 3,
  },
];

export interface ChallengeResult {
  challenge: ChallengeDef;
  passed: boolean;
  /** 0..1 of the target destroyed. */
  destroyed: number;
  /** Seconds used. */
  time: number;
  explosivesUsed: number;
  /** Target voxels destroyed per explosive used (0 when none were used). */
  efficiency: number;
  /** Total voxels removed from the whole world during the run. */
  structuralDamage: number;
  score: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  /** Score breakdown lines for the results screen. */
  breakdown: { label: string; value: string; points: number }[];
  /** Best score previously stored for this challenge (0 if none). */
  best: number;
}
