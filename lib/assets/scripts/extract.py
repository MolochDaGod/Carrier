#!/usr/bin/env python3
"""
Curate a focused subset of the attached 3D asset packs into the shared asset
library (lib/assets/models/).

This is a one-off preparation tool, not part of the library's runtime or build.
It reads the zip packs from attached_assets/ at the repo root, copies only the
web-friendly model + texture files we want, normalizes their names, and
downsamples oversized textures so the bundled library stays a reasonable size.

Run from the repo root:  python3 lib/assets/scripts/extract.py
"""

import io
import os
import re
import zipfile

from PIL import Image

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SRC = os.path.join(REPO_ROOT, "attached_assets")
DEST = os.path.join(REPO_ROOT, "lib", "assets", "models")

# Textures larger than this on their longest edge are downsampled.
MAX_TEXTURE_EDGE = 1024


def zip_path(prefix: str) -> str:
    """Find the single zip whose filename starts with the given prefix."""
    for name in os.listdir(SRC):
        if name.startswith(prefix) and name.endswith(".zip"):
            return os.path.join(SRC, name)
    raise FileNotFoundError(f"No zip starting with {prefix!r} in {SRC}")


def norm(name: str) -> str:
    """Normalize a leaf filename: lowercase, spaces/odd chars to single hyphens."""
    base, ext = os.path.splitext(os.path.basename(name))
    base = base.strip().lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return base + ext.lower()


def write_bytes(rel_dest: str, data: bytes) -> None:
    out = os.path.join(DEST, rel_dest)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(data)


def write_texture(rel_dest: str, data: bytes) -> None:
    """Write a PNG/JPG, downsampling if it exceeds MAX_TEXTURE_EDGE."""
    try:
        img = Image.open(io.BytesIO(data))
        w, h = img.size
        if max(w, h) > MAX_TEXTURE_EDGE:
            scale = MAX_TEXTURE_EDGE / max(w, h)
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
            buf = io.BytesIO()
            fmt = "PNG" if rel_dest.lower().endswith(".png") else "JPEG"
            if fmt == "JPEG" and img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(buf, fmt, optimize=True)
            data = buf.getvalue()
    except Exception as exc:  # noqa: BLE001 - keep original bytes on any decode error
        print(f"   ! texture passthrough ({exc}): {rel_dest}")
    write_bytes(rel_dest, data)


def copy(prefix: str, picks: list[tuple[str, str]]) -> None:
    """Copy (zip-entry-substring -> dest-dir) picks out of one zip."""
    zf = zipfile.ZipFile(zip_path(prefix))
    entries = [i for i in zf.infolist() if not i.filename.endswith("/")]
    for needle, dest_dir in picks:
        matched = [e for e in entries if needle in e.filename]
        for e in matched:
            data = zf.read(e.filename)
            leaf = norm(e.filename)
            rel = os.path.join(dest_dir, leaf)
            if leaf.endswith((".png", ".jpg", ".jpeg")):
                write_texture(rel, data)
            else:
                write_bytes(rel, data)


def loose_path(prefix: str, ext: str = ".fbx") -> str:
    """Find the single loose (non-zipped) source file starting with a prefix."""
    matches = sorted(
        n for n in os.listdir(SRC) if n.startswith(prefix) and n.endswith(ext)
    )
    if not matches:
        raise FileNotFoundError(f"No {ext} starting with {prefix!r} in {SRC}")
    # Sources can ship duplicate re-exports suffixed with a fresh timestamp; the
    # last one sorts highest, so take the most recent.
    return os.path.join(SRC, matches[-1])


def copy_loose(picks: list[tuple[str, str]]) -> None:
    """Copy loose source files (src-prefix -> dest-relative-path) verbatim.

    The source extension is inferred from the destination's extension, so this
    handles loose `.fbx` motion clips as well as self-contained `.glb` models.
    """
    for prefix, rel_dest in picks:
        ext = os.path.splitext(rel_dest)[1] or ".fbx"
        with open(loose_path(prefix, ext), "rb") as f:
            write_bytes(rel_dest, f.read())


def main() -> None:
    # Start clean so re-runs are deterministic.
    if os.path.isdir(DEST):
        import shutil

        shutil.rmtree(DEST)

    # --- Cube World: self-contained glTF (embedded geometry, atlas, animations).
    copy(
        "Cube_World",
        [
            ("/Enemies/glTF/", "enemies"),
            ("/Characters/glTF/", "characters"),
            ("/Animals/glTF/", "creatures"),
            ("/Environment/glTF/", "props"),
            ("/Tools/glTF/", "weapons/tools"),
            ("/Blocks/glTF/", "blocks"),
        ],
    )

    # --- Rigged humanoid characters (T-pose) sharing one diffuse texture.
    copy(
        "FreeContent_",
        [
            ("TPose_Character", "characters/humanoid"),
            ("DungeonCrawler_Character.png", "characters/humanoid"),
        ],
    )

    # --- Shared humanoid animation clips (retargetable onto the T-pose rigs).
    copy("Free_Essential_Animation", [(".fbx", "animations")])

    # --- Mixamo motion-only clip packs (no mesh) for the skeletal Animator. All
    # three target the standard 25-bone Mixamo skeleton (mixamorig*), so every
    # clip can play on one shared skeleton. Grouped by weapon class so the
    # Animator can address them as animations/<class>/<clip>.
    copy("Lite_Sword_and_Shield_Pack", [(".fbx", "animations/sword")])
    copy("Lite_Rifle_Pack", [(".fbx", "animations/rifle")])
    copy("Pro_Longbow_Pack", [(".fbx", "animations/bow")])

    # --- Traversal, farming and magic motion packs (also Mixamo 25-bone clips).
    # Climbing + swimming ship as loose FBX (not zipped); the rest are zip packs.
    # These back the animator's traversal MODEs (climb/swim) and the farming/magic
    # one-shot verbs. Names are stripped of their export-timestamp suffix.
    copy_loose(
        [
            ("Climbing_(1)", "animations/climb/climbing.fbx"),
            ("Climbing_Down_1", "animations/climb/climbing-down.fbx"),
            ("Climbing_Down_Wall", "animations/climb/climbing-down-wall.fbx"),
            ("Climbing_Up_Wall", "animations/climb/climbing-up-wall.fbx"),
            ("Climbing_To_Top", "animations/climb/climbing-to-top.fbx"),
            ("Swimming_(1)", "animations/swim/swimming.fbx"),
            ("Swimming_(2)", "animations/swim/swimming-2.fbx"),
            ("Swimming_To_Edge", "animations/swim/swimming-to-edge.fbx"),
            ("Treading_Water", "animations/swim/treading-water.fbx"),
        ]
    )
    copy("Farming_Pack", [(".fbx", "animations/farming")])
    copy("Magic_Spell_Pack", [(".fbx", "animations/magic")])
    copy("Magic_Locomotion_Pack", [(".fbx", "animations/magic-loco")])

    # --- Creatures: skinned + static animals.
    copy(
        "Free_Sample_17808147",
        [
            ("Skinned FBX", "creatures/skinned"),
            ("Static FBX", "creatures/static"),
        ],
    )

    # --- Standalone Blockbench / Meshy creature + prop GLBs. These ship as
    # loose, self-contained .glb files (geometry, embedded textures and their own
    # animation clips all baked in), so they are copied verbatim into the catalog
    # — no texture downsample or atlas matching needed. Animals/enemies/bosses
    # land in creatures|enemies, the cannon in props, the lava block in
    # environment. The "fighting style" rigs (karate-boss, sanji) carry their own
    # embedded combat clips for the combat tasks to drive directly.
    copy_loose(
        [
            ("mini_dragon", "enemies/mini-dragon.glb"),
            ("revamped_ender_dragon", "enemies/ender-dragon.glb"),
            ("leathern_drake", "enemies/leathern-drake.glb"),
            ("skeleton_warrior", "enemies/skeleton-warrior.glb"),
            ("upgraded_iron_golem", "enemies/iron-golem.glb"),
            ("whulvk_werewolf", "enemies/werewolf.glb"),
            ("minecraft_-_orc", "enemies/orc.glb"),
            ("karate_boss", "enemies/karate-boss.glb"),
            ("sanji_fighting_style", "enemies/sanji.glb"),
            ("owl_99", "creatures/owl.glb"),
            ("rhinoceros", "creatures/rhinoceros.glb"),
            ("cheetah", "creatures/cheetah.glb"),
            ("crocodile", "creatures/crocodile.glb"),
            ("cannon", "props/cannon.glb"),
            ("voxel_lava", "environment/voxel-lava.glb"),
        ]
    )

    # --- Weapons: modern firearms (shared atlas) + voxel RPG weapons.
    copy("Free_Sample_(4)_178081564", [(".fbx", "weapons/guns"), ("T_Weapons.png", "weapons/guns")])
    copy(
        "Voxel_RPG_Weapons",
        [(".obj", "weapons/voxel"), (".mtl", "weapons/voxel")],
    )
    # Voxel weapon palette textures (skip the *-preview.png thumbnails).
    zf = zipfile.ZipFile(zip_path("Voxel_RPG_Weapons"))
    for e in zf.infolist():
        fn = e.filename
        if fn.endswith(".png") and "preview" not in fn:
            write_texture(os.path.join("weapons/voxel", norm(fn)), zf.read(fn))

    # --- Vehicles / mechs (OBJ + palette; skip heavy .ply and .gif previews).
    copy("Gun_Bike", [("GunBike-0", "vehicles")])
    copy("Tracer", [("Tracer-0", "vehicles")])
    copy("Companion-bot", [("Companion-bot.obj", "vehicles"), ("Companion-bot.mtl", "vehicles"), ("Companion-bot.png", "vehicles")])
    copy("Dictators", [("Dictators-", "vehicles")])

    # --- Themed environment kits (FBX/OBJ geometry + downsampled atlas textures).
    copy(
        "FreeSample_(2)_",
        [("FreeContent/", "environment/dungeon"), ("Textures/Diffuse/", "environment/dungeon/textures")],
    )
    copy("FreeSample_(4)_178081500", [("FreeSample/", "environment/gothic")])
    copy(
        "FreeSample_(5)_",
        [("FreeSample/", "environment/mars"), ("Textures/Bakes/", "environment/mars/textures")],
    )
    copy(
        "FreeSample_(6)_",
        [("FreeSample/", "environment/tropical")],
    )
    copy(
        "FreeSample_(7)_",
        [("FreeSample/", "environment/city")],
    )

    print("Done. Extracted into", DEST)


if __name__ == "__main__":
    main()
