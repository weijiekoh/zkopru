export const MiMCABI = [
  {
    constant: true,
    inputs: [
      { name: 'xL_in', type: 'uint256' },
      { name: 'xR_in', type: 'uint256' },
      { name: 'k', type: 'uint256' },
    ],
    name: 'MiMCSponge',
    outputs: [
      { name: 'xL', type: 'uint256' },
      { name: 'xR', type: 'uint256' },
    ],
    payable: false,
    stateMutability: 'pure',
    type: 'function',
  },
]
