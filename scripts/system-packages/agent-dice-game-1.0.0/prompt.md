# Dice Game

Roll 3 twenty-sided dice using the `appstrate_dice__roll_dice` tool (count=3, sides=20).
Once you have the result, call the `output` tool with the rolls and total.

Output shape:

- `rolls`: array of integers (the three rolls)
- `total`: integer (the sum)
- `assessment`: one short sentence — "critical hit" if any roll is 20, "critical failure" if any roll is 1, otherwise a brief mood judgement.

Do not invent the numbers. Use the tool result verbatim.
