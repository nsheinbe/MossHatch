/**
 * A small list of common English words (3 to 8 letters) for the name-quality score. It is deliberately short: a name that is a real
 * word, or two of them joined, reads as a "found" name. Anything not here is judged on length and how it sounds instead.
 */
const LIST = `
able acorn act air amber angel ant apple arch arrow art ash aspen atlas autumn axe
badge bake bar bark barn basin bay beach beam bean bear bee bell berry birch bird bit black blade bloom blue boat bold bolt bone book
boot bough box brand brass brave bread brick bridge bright brook broom brown buck bud bug burrow bush
cabin cake calm camp candle cap cape card care cart castle cat cave cedar chair chalk charm chart cheer cherry chest chip cider
city clay cliff cloud clover coal coast coat code comet copper coral cord core corn cove crab craft crane creek crest crow crown
cub cup curl dale dark dawn day deep deer den desk dew dove down dragon dream drift drop drum dune dusk dust
eagle earth east echo edge egg elm ember end fable face fair fall fawn feast feather fen fern field fig finch fire fish flag flame
flash fleet flint flock flower fly fog folk forest forge fort fox frost fruit gale garden gate gem ghost gift glade glass glen glow
gold good grain grape grass green grey grove guild gull hail hall hare harbor harp hatch haven hawk hay hazel heart hearth heath
hedge hen herb hero hill hive hollow home honey hood hook hope horn house ice inn iron isle ivy jade jar jay jet joy key kind
king kite knot lake lamb lamp land lane lantern lark leaf ledge lemon light lily lime line lion loft log loom lotus lucky lunar
maple marble marsh mast meadow mellow mesa mill mint mist moon moor moss moth mouse mud nest net new night north nook nut
oak oat ocean olive onyx open orbit orchid otter owl page paint palm paper park path peach peak pear pearl pebble pepper pine
pixel plain plum pod point pond pony pool poppy port post quail quest quiet quill rain raven reed reef ridge ring river road robin
rock root rope rose ruby rush rust sage sail salt sand scout sea seed shade shell shore silk silver sky slate sloe snow soft
song south spark spice spire spoon spring spruce star stem still stone storm stream sun swan sweet swift table tale tall tea
thorn thread tide tiger timber tin toad torch tower trail tree tulip twig vale valley vine violet wave wax west whale wheat wick
wild willow wind wing winter wish wolf wood wool wren yard yarrow yew zest zinc
bramble thistle marrow soot tinker hatch kind clock glim wisp gleam
`;

export const WORDS: ReadonlySet<string> = new Set(LIST.split(/\s+/).filter(Boolean));
