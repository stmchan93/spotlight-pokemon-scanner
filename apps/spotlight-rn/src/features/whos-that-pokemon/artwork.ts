/**
 * Official artwork for a National Pokédex number, served from the PokeAPI
 * sprites repo. Loaded through `CachedImage`/`expo-image` so repeat views hit
 * the disk cache instead of the network.
 */
export function officialArtworkUrl(pokedexId: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokedexId}.png`;
}
