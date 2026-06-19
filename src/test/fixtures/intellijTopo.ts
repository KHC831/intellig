/**
 * Real-topology graph regression fixture — captured from the IntelliJ
 * Community repository (the project's north-star reference), the same repo
 * git4idea ships against.
 *
 * Provenance / reproduction (captured 2026-06-19):
 *   git -C <intellij-community> log --topo-order --pretty="%H %P" \
 *       -n 150 ab237fc72ddea7da79e6989f6c0f5bc01ef70cf8
 *
 * The window is anchored at the branch-sync merge ab237fc7 and walks 150
 * commits of real, merge-rich history (it includes the 2-parent branch-sync
 * merges ab237fc7 and 773e9b67, plus other merges). Only the immutable commit
 * + parent hashes are baked in — that is everything the lane algorithm
 * consumes — so the fixture is fully deterministic and the test NEVER reads the
 * live repo. Parents that fall outside the 150-commit window are legitimate
 * off-window stubs (the topology is captured from a much larger DAG); the
 * regression test treats them as documented off-window terminations.
 *
 * DO NOT regenerate casually: these hashes are a fixed historical snapshot.
 */

export interface IIntellijTopoCommit {
  hash: string;
  parents: string[];
}

export const INTELLIJ_TOPO_ANCHOR = 'ab237fc72ddea7da79e6989f6c0f5bc01ef70cf8';

export const INTELLIJ_TOPO: IIntellijTopoCommit[] = [
  {
    hash: 'ab237fc72ddea7da79e6989f6c0f5bc01ef70cf8',
    parents: [
      'e2e6098849c984a2a5895bebaf1aa0a5c5d1444f',
      'f78e8ad1f167db44230ea9a92738a8d3575be90d',
    ],
  },
  {
    hash: 'f78e8ad1f167db44230ea9a92738a8d3575be90d',
    parents: ['7454993000fb42ad8e56752fa43d2733d526d0e0'],
  },
  {
    hash: '7454993000fb42ad8e56752fa43d2733d526d0e0',
    parents: ['dd4fb564f0fb06b96320f833dbd688ab7fc88254'],
  },
  {
    hash: 'dd4fb564f0fb06b96320f833dbd688ab7fc88254',
    parents: [
      'c940fa24bf887565dbfe05d2889c0750e38ab23c',
      'b41d292b05c5a45b2c9db0ede85dc9d52e21e660',
    ],
  },
  {
    hash: 'b41d292b05c5a45b2c9db0ede85dc9d52e21e660',
    parents: ['773e9b67ca37d67d74ee7c9837081bd4319542a2'],
  },
  {
    hash: '773e9b67ca37d67d74ee7c9837081bd4319542a2',
    parents: [
      'ed2d8af87005af98f863cccc160a3b35403c7973',
      '655636003ddb520839472aed1c8cadb54b72e227',
    ],
  },
  {
    hash: '655636003ddb520839472aed1c8cadb54b72e227',
    parents: ['d33c9b83e486ed93f58760aa99aae60db74f0456'],
  },
  {
    hash: 'd33c9b83e486ed93f58760aa99aae60db74f0456',
    parents: ['984f3d60ccfe08a979ff3cf3e2c9ad8a9433b5eb'],
  },
  {
    hash: '984f3d60ccfe08a979ff3cf3e2c9ad8a9433b5eb',
    parents: [
      'f5b034ad55278c0da68ec36be0daa9e6ac901c58',
      '5bb89d29ac3b66854682a0b006d2f0ec8e95bd13',
    ],
  },
  {
    hash: '5bb89d29ac3b66854682a0b006d2f0ec8e95bd13',
    parents: ['c0db10a712bc5706e7f39ba38c3a81d2126b28c7'],
  },
  {
    hash: 'c0db10a712bc5706e7f39ba38c3a81d2126b28c7',
    parents: ['6f59365c248c328ccbecc14a2fb0f09ce8fb5c26'],
  },
  {
    hash: '6f59365c248c328ccbecc14a2fb0f09ce8fb5c26',
    parents: ['ad5de7918b8b402480f71c5b31cc2cacb67c7884'],
  },
  {
    hash: 'ad5de7918b8b402480f71c5b31cc2cacb67c7884',
    parents: ['c8c6092596f289d92a50a40ba72e3824fb689b96'],
  },
  {
    hash: 'c8c6092596f289d92a50a40ba72e3824fb689b96',
    parents: ['29597e95db8e7ddc40df254b0d9e5bdbb55470a7'],
  },
  {
    hash: '29597e95db8e7ddc40df254b0d9e5bdbb55470a7',
    parents: ['42dcb42b98fe2818a82788ebec9e7ee788647f9f'],
  },
  {
    hash: '42dcb42b98fe2818a82788ebec9e7ee788647f9f',
    parents: ['6fb5abe8a734f7224875101e6b33d7cd6a89247e'],
  },
  {
    hash: '6fb5abe8a734f7224875101e6b33d7cd6a89247e',
    parents: ['8e78da0eccd16f5af188c1f3c5b1361125e18fed'],
  },
  {
    hash: '8e78da0eccd16f5af188c1f3c5b1361125e18fed',
    parents: ['1e3b894bd03f756516b3fc57dc31d23e0562a563'],
  },
  {
    hash: '1e3b894bd03f756516b3fc57dc31d23e0562a563',
    parents: ['60d0cebb869b601e56256252d942817182603009'],
  },
  {
    hash: '60d0cebb869b601e56256252d942817182603009',
    parents: ['f0a66fcb85c7b199c5c6dab4c20d37c7885b43e4'],
  },
  {
    hash: 'f0a66fcb85c7b199c5c6dab4c20d37c7885b43e4',
    parents: ['7412075fd186e291cce905c8b634706ed6022da6'],
  },
  {
    hash: '7412075fd186e291cce905c8b634706ed6022da6',
    parents: ['61d3df2c59c523dc8eef1fdb36d3a298129f9dce'],
  },
  {
    hash: '61d3df2c59c523dc8eef1fdb36d3a298129f9dce',
    parents: ['c4957d087312094eaa25553945eb90204a7844f1'],
  },
  {
    hash: 'ed2d8af87005af98f863cccc160a3b35403c7973',
    parents: ['3e10fa1e0318cc9991e8405f9da478d964be430f'],
  },
  {
    hash: '3e10fa1e0318cc9991e8405f9da478d964be430f',
    parents: ['dd729e3ad9998e9f15bc3cb5d887fba1f697f051'],
  },
  {
    hash: 'dd729e3ad9998e9f15bc3cb5d887fba1f697f051',
    parents: ['c093e67bb532796ef1e640f0d0305bc60e09aea9'],
  },
  {
    hash: 'c093e67bb532796ef1e640f0d0305bc60e09aea9',
    parents: ['4fb1d11123078553d2eca313b6b109c5261b4826'],
  },
  {
    hash: '4fb1d11123078553d2eca313b6b109c5261b4826',
    parents: ['334890eaf156fc03b3b53b263e166015d3675ed0'],
  },
  {
    hash: '334890eaf156fc03b3b53b263e166015d3675ed0',
    parents: ['96df78fb5da2975bd06d5cb0996526cb895e889c'],
  },
  {
    hash: '96df78fb5da2975bd06d5cb0996526cb895e889c',
    parents: ['b97b7840c9160233c93f1af8b71d334e90b789e2'],
  },
  {
    hash: 'b97b7840c9160233c93f1af8b71d334e90b789e2',
    parents: ['b96f9208a41ec2a326ab7b055df08ddc2875ccc7'],
  },
  {
    hash: 'b96f9208a41ec2a326ab7b055df08ddc2875ccc7',
    parents: ['ae54a45a9c5d8d9bb36043dce5937f79babe0bc2'],
  },
  {
    hash: 'ae54a45a9c5d8d9bb36043dce5937f79babe0bc2',
    parents: ['883dbe0833c1c72b8287a9c3231034097551d55f'],
  },
  {
    hash: '883dbe0833c1c72b8287a9c3231034097551d55f',
    parents: ['0b91073834cbc0c7a30d7f36be5425c452371d9f'],
  },
  {
    hash: '0b91073834cbc0c7a30d7f36be5425c452371d9f',
    parents: ['f3dd4392f9eedf632ea2d90f3a84e599a5b5bf23'],
  },
  {
    hash: 'f3dd4392f9eedf632ea2d90f3a84e599a5b5bf23',
    parents: ['f46e29ec6a9e08f3fde3232ffe1de20a2b37b62b'],
  },
  {
    hash: 'f46e29ec6a9e08f3fde3232ffe1de20a2b37b62b',
    parents: ['a3f88619a2d999a835e172cae00afa8b9ef1562d'],
  },
  {
    hash: 'a3f88619a2d999a835e172cae00afa8b9ef1562d',
    parents: ['45db6444430815f123cf4bdd2c1a674e896d5c9a'],
  },
  {
    hash: '45db6444430815f123cf4bdd2c1a674e896d5c9a',
    parents: ['a58d4f11c7773697f7ece6941b7df4e3144ea3c4'],
  },
  {
    hash: 'a58d4f11c7773697f7ece6941b7df4e3144ea3c4',
    parents: ['9925423f71d7158b8452406b316945ffac75dbbc'],
  },
  {
    hash: '9925423f71d7158b8452406b316945ffac75dbbc',
    parents: ['c6995d0e129eb0f2f61cbe293f172a6a196e0680'],
  },
  {
    hash: 'c6995d0e129eb0f2f61cbe293f172a6a196e0680',
    parents: ['641c9916cd7c337b50cc5490449005851687c8dd'],
  },
  {
    hash: '641c9916cd7c337b50cc5490449005851687c8dd',
    parents: ['9cbce0faf50cfc4230228e6d5ba6e1d4c4d95c37'],
  },
  {
    hash: '9cbce0faf50cfc4230228e6d5ba6e1d4c4d95c37',
    parents: ['8dad834e58a6ddb8a852db6db8a2974ef050c027'],
  },
  {
    hash: '8dad834e58a6ddb8a852db6db8a2974ef050c027',
    parents: ['7616d7597081049cd623684fcd26570b863d4052'],
  },
  {
    hash: '7616d7597081049cd623684fcd26570b863d4052',
    parents: ['0a4a329d0f205829c3e8ae6272fedc4858fb67f4'],
  },
  {
    hash: '0a4a329d0f205829c3e8ae6272fedc4858fb67f4',
    parents: ['85887edee2c144d09102fa78f5f23f2ffce567cd'],
  },
  {
    hash: '85887edee2c144d09102fa78f5f23f2ffce567cd',
    parents: ['28a517dd5ceb84971ffc0fe79c2053f7823054f6'],
  },
  {
    hash: '28a517dd5ceb84971ffc0fe79c2053f7823054f6',
    parents: ['a3e2bda3f7d318f74c18bea582f766e8b3be6b76'],
  },
  {
    hash: 'a3e2bda3f7d318f74c18bea582f766e8b3be6b76',
    parents: ['42f09119f0acfa241071d520d61dec4d524ca7f2'],
  },
  {
    hash: '42f09119f0acfa241071d520d61dec4d524ca7f2',
    parents: ['c6dc59eb1e7028da68e518fe777502b73ec25e10'],
  },
  {
    hash: 'c6dc59eb1e7028da68e518fe777502b73ec25e10',
    parents: ['aa52c98c1a80132c41d3617f04039fa10c88316b'],
  },
  {
    hash: 'aa52c98c1a80132c41d3617f04039fa10c88316b',
    parents: ['73205e17018444d9fd045eb4d095542e00870d71'],
  },
  {
    hash: '73205e17018444d9fd045eb4d095542e00870d71',
    parents: ['8b96f0a03287cb9049f97ed09d8807aded7e831e'],
  },
  {
    hash: '8b96f0a03287cb9049f97ed09d8807aded7e831e',
    parents: ['ebc1f76090d54cb76d6c164e7cd3d9e123f5a5d5'],
  },
  {
    hash: 'ebc1f76090d54cb76d6c164e7cd3d9e123f5a5d5',
    parents: ['5f41f47bdd92d97eb18f3a60fcc1ce06875e93da'],
  },
  {
    hash: '5f41f47bdd92d97eb18f3a60fcc1ce06875e93da',
    parents: ['ae7bb784cdf95ab80ba1cbb91070b92c5cb224be'],
  },
  {
    hash: 'ae7bb784cdf95ab80ba1cbb91070b92c5cb224be',
    parents: ['72f2057f776403c6eedadb10ec6c6613fb597de9'],
  },
  {
    hash: '72f2057f776403c6eedadb10ec6c6613fb597de9',
    parents: ['64e073ca43812807b25f5866c563a82bbc043153'],
  },
  {
    hash: '64e073ca43812807b25f5866c563a82bbc043153',
    parents: ['12fb586828156412d8edf05acb614808e0eb60a2'],
  },
  {
    hash: '12fb586828156412d8edf05acb614808e0eb60a2',
    parents: ['b60b7aaa7b47ba6b2e8068568b594fc0e77119af'],
  },
  {
    hash: 'b60b7aaa7b47ba6b2e8068568b594fc0e77119af',
    parents: ['55a787160e95d8c80ca1448bc8e2a876c4e8d4c4'],
  },
  {
    hash: '55a787160e95d8c80ca1448bc8e2a876c4e8d4c4',
    parents: ['75a456bf84c31f9452e5f94367570a7b26fece4e'],
  },
  {
    hash: '75a456bf84c31f9452e5f94367570a7b26fece4e',
    parents: ['97a58c686400038f5f0c30dfba7c7d14f5297523'],
  },
  {
    hash: '97a58c686400038f5f0c30dfba7c7d14f5297523',
    parents: ['0ec45eb1c15c40c2a04532c1e81dc47d2e82fdbd'],
  },
  {
    hash: '0ec45eb1c15c40c2a04532c1e81dc47d2e82fdbd',
    parents: ['9697e13315196ba3d4af9e754848b9f4ca713b2d'],
  },
  {
    hash: '9697e13315196ba3d4af9e754848b9f4ca713b2d',
    parents: ['6502a9320b45526e0d0af5a1fc23f94c64aaef85'],
  },
  {
    hash: '6502a9320b45526e0d0af5a1fc23f94c64aaef85',
    parents: ['56dd68e6f1fcc5ef2801089556855ac5ebfd0f3b'],
  },
  {
    hash: '56dd68e6f1fcc5ef2801089556855ac5ebfd0f3b',
    parents: ['2a289885fc08a9676f9ff7bd297eb216828db287'],
  },
  {
    hash: '2a289885fc08a9676f9ff7bd297eb216828db287',
    parents: ['388020fca0b8e33c6b614d5b8d8b659d008f65b2'],
  },
  {
    hash: '388020fca0b8e33c6b614d5b8d8b659d008f65b2',
    parents: ['b5e9d8a3a6cf74eab63bad10c08579d395476ea4'],
  },
  {
    hash: 'b5e9d8a3a6cf74eab63bad10c08579d395476ea4',
    parents: ['2f6c8c057c950b8eaaea5a48c478c593aa977720'],
  },
  {
    hash: '2f6c8c057c950b8eaaea5a48c478c593aa977720',
    parents: ['d435d7548e8b152f3daaa77fc0a7d3ed534aad82'],
  },
  {
    hash: 'd435d7548e8b152f3daaa77fc0a7d3ed534aad82',
    parents: ['396bcb5341fd7dbea7b203edd910dd3fb4f88f57'],
  },
  {
    hash: '396bcb5341fd7dbea7b203edd910dd3fb4f88f57',
    parents: ['163ad244cf84014a8221e96c0fb3ffbae23f75b3'],
  },
  {
    hash: '163ad244cf84014a8221e96c0fb3ffbae23f75b3',
    parents: ['24c221374a417baf5f945ff3550909c3560bf0a9'],
  },
  {
    hash: '24c221374a417baf5f945ff3550909c3560bf0a9',
    parents: ['3fb095da144015a6698d2e392ba1c6e02f852d8b'],
  },
  {
    hash: '3fb095da144015a6698d2e392ba1c6e02f852d8b',
    parents: ['dc87cadb9b8d63eb178d9a504370bf5f8bde940a'],
  },
  {
    hash: 'dc87cadb9b8d63eb178d9a504370bf5f8bde940a',
    parents: ['ca5a438664837577e69e115cba2c9024fa52e44e'],
  },
  {
    hash: 'ca5a438664837577e69e115cba2c9024fa52e44e',
    parents: ['3ce209a68c50c20738ad165bab1d963f5f833748'],
  },
  {
    hash: '3ce209a68c50c20738ad165bab1d963f5f833748',
    parents: ['97a889b629805fd922bf7aed0bb41011a2c150fe'],
  },
  {
    hash: '97a889b629805fd922bf7aed0bb41011a2c150fe',
    parents: ['ea24ef77003569454eca7db28db36714825e25bf'],
  },
  {
    hash: 'ea24ef77003569454eca7db28db36714825e25bf',
    parents: ['1fdba2f57775e373995c031964ef54457ea9e0f6'],
  },
  {
    hash: '1fdba2f57775e373995c031964ef54457ea9e0f6',
    parents: ['78a1ac6ac4ca9e31035c745c99e3be6cfca94db3'],
  },
  {
    hash: '78a1ac6ac4ca9e31035c745c99e3be6cfca94db3',
    parents: ['9660fc50b004ce41441821cb1290b1eefe1e884f'],
  },
  {
    hash: '9660fc50b004ce41441821cb1290b1eefe1e884f',
    parents: ['9b7f190e677f919e79327d53a70446316d0dddfe'],
  },
  {
    hash: '9b7f190e677f919e79327d53a70446316d0dddfe',
    parents: ['74ea1b54abf4f1a89f422f21e58670928634d9a7'],
  },
  {
    hash: '74ea1b54abf4f1a89f422f21e58670928634d9a7',
    parents: ['f4ab7451bb770677509e7bc517a7fca8f819b151'],
  },
  {
    hash: 'f4ab7451bb770677509e7bc517a7fca8f819b151',
    parents: ['e27a1da73627f8b007f9dee4b1e53ec98536a63e'],
  },
  {
    hash: 'e27a1da73627f8b007f9dee4b1e53ec98536a63e',
    parents: ['c5cd8e2a743778d32008b6216afec2665d707c8a'],
  },
  {
    hash: 'c5cd8e2a743778d32008b6216afec2665d707c8a',
    parents: ['989b0e8751cd1db27f1e7cd76c97889f0eeac5cd'],
  },
  {
    hash: '989b0e8751cd1db27f1e7cd76c97889f0eeac5cd',
    parents: ['50f2f12371e2836757455abc92ee179b0b3afe43'],
  },
  {
    hash: '50f2f12371e2836757455abc92ee179b0b3afe43',
    parents: ['34cf08f4947f5ce0cc96896538c93bfd255a68d1'],
  },
  {
    hash: '34cf08f4947f5ce0cc96896538c93bfd255a68d1',
    parents: ['777ce0018327867c52b71c254df245a09b8d7175'],
  },
  {
    hash: '777ce0018327867c52b71c254df245a09b8d7175',
    parents: ['06a43595fab10f4eee20843f5d5af54aad141372'],
  },
  {
    hash: '06a43595fab10f4eee20843f5d5af54aad141372',
    parents: ['fc6da2992b990b9afab1a2547653bccc28c22ac2'],
  },
  {
    hash: 'fc6da2992b990b9afab1a2547653bccc28c22ac2',
    parents: ['1ac4989d7c3a23d31264a54aea7e2e2def1ef437'],
  },
  {
    hash: '1ac4989d7c3a23d31264a54aea7e2e2def1ef437',
    parents: ['351d48fdd8892955944e41209ce0285afd6e5ee7'],
  },
  {
    hash: '351d48fdd8892955944e41209ce0285afd6e5ee7',
    parents: ['803a940babb3da2bc2664d7b6c466d6f8332e7f1'],
  },
  {
    hash: '803a940babb3da2bc2664d7b6c466d6f8332e7f1',
    parents: ['1923eca5edc6ec16b962d185d60ccc32d38f22cb'],
  },
  {
    hash: '1923eca5edc6ec16b962d185d60ccc32d38f22cb',
    parents: ['4569a7c991b9e74d1f0526c04139608f9fe8019a'],
  },
  {
    hash: '4569a7c991b9e74d1f0526c04139608f9fe8019a',
    parents: ['e011fa81b210c99aa6a5a854b2ea920e35fa993c'],
  },
  {
    hash: 'e011fa81b210c99aa6a5a854b2ea920e35fa993c',
    parents: ['80b3bc4f237cea52ec11b9e345356477a84ddf04'],
  },
  {
    hash: '80b3bc4f237cea52ec11b9e345356477a84ddf04',
    parents: ['b953e855454c2d9e24b0832925866ff186bd8958'],
  },
  {
    hash: 'b953e855454c2d9e24b0832925866ff186bd8958',
    parents: ['f0d1ef661834312e2466a260d5b530e4845c614f'],
  },
  {
    hash: 'f0d1ef661834312e2466a260d5b530e4845c614f',
    parents: ['e865a36bd1c5bfa0b0f03dbd315f20d76f6f99cb'],
  },
  {
    hash: 'e865a36bd1c5bfa0b0f03dbd315f20d76f6f99cb',
    parents: ['7b32c939d41adf7675499a35d59169efeac94a3e'],
  },
  {
    hash: '7b32c939d41adf7675499a35d59169efeac94a3e',
    parents: ['30730b67a3a09a25cce7384948fee076ad2cdb1d'],
  },
  {
    hash: '30730b67a3a09a25cce7384948fee076ad2cdb1d',
    parents: ['b726db98c4ca82f0ba7af7ba9983ab7c16e0d8a2'],
  },
  {
    hash: 'b726db98c4ca82f0ba7af7ba9983ab7c16e0d8a2',
    parents: ['5822a77789e88856fcc42ccdcd38b0d60b2e1f24'],
  },
  {
    hash: '5822a77789e88856fcc42ccdcd38b0d60b2e1f24',
    parents: ['576f5af5c1e73a5143a08c8d754bc81a9646378d'],
  },
  {
    hash: '576f5af5c1e73a5143a08c8d754bc81a9646378d',
    parents: ['53f6d3d1139d2cb155d4f6bfe3ce7b2968a9e55c'],
  },
  {
    hash: '53f6d3d1139d2cb155d4f6bfe3ce7b2968a9e55c',
    parents: ['71ecaf406b23cbc82eac09e35ce8caf290fc696c'],
  },
  {
    hash: '71ecaf406b23cbc82eac09e35ce8caf290fc696c',
    parents: ['a585ce719ed28d9d00384414fa66f18f08eac4e6'],
  },
  {
    hash: 'a585ce719ed28d9d00384414fa66f18f08eac4e6',
    parents: ['eabcf4c622d4d32ce9e187e6fa185f26971e3ae4'],
  },
  {
    hash: 'eabcf4c622d4d32ce9e187e6fa185f26971e3ae4',
    parents: ['5262fdddfac40d16c100b0b4e116a652b5263df7'],
  },
  {
    hash: '5262fdddfac40d16c100b0b4e116a652b5263df7',
    parents: ['2c9b0b90e7fb6196b84e0ad5f7b77f5795db977a'],
  },
  {
    hash: '2c9b0b90e7fb6196b84e0ad5f7b77f5795db977a',
    parents: ['9e93bba8157f325d3e3e38977ee4b53d27c369c8'],
  },
  {
    hash: '9e93bba8157f325d3e3e38977ee4b53d27c369c8',
    parents: ['87ba37d2e0fd162444f66007f3ca0d657af3d147'],
  },
  {
    hash: '87ba37d2e0fd162444f66007f3ca0d657af3d147',
    parents: ['7369e818ae06918b94b6b212553c23e0fee5f58a'],
  },
  {
    hash: '7369e818ae06918b94b6b212553c23e0fee5f58a',
    parents: ['c2835ee2fc3d21e2b56e0fabe9bc5e41ecdfd6fc'],
  },
  {
    hash: 'c2835ee2fc3d21e2b56e0fabe9bc5e41ecdfd6fc',
    parents: ['f5b034ad55278c0da68ec36be0daa9e6ac901c58'],
  },
  {
    hash: 'f5b034ad55278c0da68ec36be0daa9e6ac901c58',
    parents: ['124ff843fe8a3ec68bcac76796064a6063861bea'],
  },
  {
    hash: '124ff843fe8a3ec68bcac76796064a6063861bea',
    parents: ['53149dfd6a08f36196b6e23d7109a09407e77b28'],
  },
  {
    hash: '53149dfd6a08f36196b6e23d7109a09407e77b28',
    parents: ['d86cc0c976aa90f24ea5f72ec5ff4d21c4d950fc'],
  },
  {
    hash: 'd86cc0c976aa90f24ea5f72ec5ff4d21c4d950fc',
    parents: ['4d9454536ff3ec43a7071fdad82589445499dcf8'],
  },
  {
    hash: '4d9454536ff3ec43a7071fdad82589445499dcf8',
    parents: ['c0c4ceeefcca71e34a7000f36562a43d672ebf25'],
  },
  {
    hash: 'c0c4ceeefcca71e34a7000f36562a43d672ebf25',
    parents: ['346ebebeaf43c87ae03df9bbce30a92ce6402aa4'],
  },
  {
    hash: '346ebebeaf43c87ae03df9bbce30a92ce6402aa4',
    parents: ['eebdd51a122b331a508031203501b52838451dfd'],
  },
  {
    hash: 'eebdd51a122b331a508031203501b52838451dfd',
    parents: ['e6d0661469fe99942932830fc8dded7f5f60ebbf'],
  },
  {
    hash: 'e6d0661469fe99942932830fc8dded7f5f60ebbf',
    parents: ['cbea9b541e9bd2f11c6047a56667f9c726469fd3'],
  },
  {
    hash: 'cbea9b541e9bd2f11c6047a56667f9c726469fd3',
    parents: ['1f72a4c121536e6ef5fad29875369a11701e4c2f'],
  },
  {
    hash: '1f72a4c121536e6ef5fad29875369a11701e4c2f',
    parents: ['1e7e0f9741073bf21339cde7a843e478eead6e9f'],
  },
  {
    hash: '1e7e0f9741073bf21339cde7a843e478eead6e9f',
    parents: ['8735de4bab1db3609b6bd908338350538cf63e8f'],
  },
  {
    hash: '8735de4bab1db3609b6bd908338350538cf63e8f',
    parents: ['c077b2b25157dc8fb31304e1a6a8914c5ca9fb87'],
  },
  {
    hash: 'c077b2b25157dc8fb31304e1a6a8914c5ca9fb87',
    parents: ['e0cbfcb24486a86fac45c74b2376fbc36d0a6b6e'],
  },
  {
    hash: 'e0cbfcb24486a86fac45c74b2376fbc36d0a6b6e',
    parents: ['883ed9701a97ac1aa02c1f61f723a1273104bceb'],
  },
  {
    hash: '883ed9701a97ac1aa02c1f61f723a1273104bceb',
    parents: ['658df3ec62fa22d7e68e94dbf973364abdfb46d3'],
  },
  {
    hash: '658df3ec62fa22d7e68e94dbf973364abdfb46d3',
    parents: ['603507158add66f6cc12472d2b201f721c85a682'],
  },
  {
    hash: '603507158add66f6cc12472d2b201f721c85a682',
    parents: ['328f52c22a94073cee7fccbdf3e22bdce84741e6'],
  },
  {
    hash: '328f52c22a94073cee7fccbdf3e22bdce84741e6',
    parents: ['03226bb733c9c2d46a6ef133f1bcafc6f5454d20'],
  },
  {
    hash: '03226bb733c9c2d46a6ef133f1bcafc6f5454d20',
    parents: ['7996bb33dc686e905cab7f8596870216c26fe46c'],
  },
  {
    hash: '7996bb33dc686e905cab7f8596870216c26fe46c',
    parents: ['a30073abff329c9945b992a795fdabe715567436'],
  },
  {
    hash: 'a30073abff329c9945b992a795fdabe715567436',
    parents: ['a5c09533c6066eb1295d677b599b92a94f82f52b'],
  },
  {
    hash: 'a5c09533c6066eb1295d677b599b92a94f82f52b',
    parents: ['473992700db2d2d345077c975db694099f896d78'],
  },
  {
    hash: '473992700db2d2d345077c975db694099f896d78',
    parents: ['36d7575fa346a2aa6ef9682145396f103b714109'],
  },
  {
    hash: '36d7575fa346a2aa6ef9682145396f103b714109',
    parents: ['d5f777257ee6ed7284eaa72ee80b7562949990eb'],
  },
  {
    hash: 'd5f777257ee6ed7284eaa72ee80b7562949990eb',
    parents: ['0f8eb6053e5d2a87f9b9e7235defe898d17693ed'],
  },
  {
    hash: '0f8eb6053e5d2a87f9b9e7235defe898d17693ed',
    parents: ['b70b40637de735b2beabee2dc575134128eb7eb9'],
  },
  {
    hash: 'b70b40637de735b2beabee2dc575134128eb7eb9',
    parents: ['f82dce98fee5d1f9054e4622f46a20efcf07b2e4'],
  },
];
