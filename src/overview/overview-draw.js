/* global d3 */

import { get } from 'svelte/store';
import {
  svgStore, vSpaceAroundGapStore, hSpaceAroundGapStore, cnnStore,
  nodeCoordinateStore, selectedScaleLevelStore, cnnLayerRangesStore
} from '../stores.js';
import {
  getExtent, getOutputKnot, getInputKnot, getLinkData
} from './overview-utils.js';
import { singleConv } from '../utils/cnn.js';
import { overviewConfig } from '../config.js';

// Configs
const layerColorScales = overviewConfig.layerColorScales;
const nodeLength = overviewConfig.nodeLength;
const plusSymbolRadius = overviewConfig.plusSymbolRadius;
const numLayers = overviewConfig.numLayers;
const edgeOpacity = overviewConfig.edgeOpacity;
const edgeInitColor = overviewConfig.edgeInitColor;
const edgeHoverColor = overviewConfig.edgeHoverColor;
const edgeHoverOuting = overviewConfig.edgeHoverOuting;
const edgeStrokeWidth = overviewConfig.edgeStrokeWidth;
const intermediateColor = overviewConfig.intermediateColor;
const kernelRectLength = overviewConfig.kernelRectLength;
const svgPaddings = overviewConfig.svgPaddings;
const gapRatio = overviewConfig.gapRatio;

// Shared variables
let svg = undefined;
svgStore.subscribe( value => {svg = value;} )

let vSpaceAroundGap = undefined;
vSpaceAroundGapStore.subscribe( value => {vSpaceAroundGap = value;} )

let hSpaceAroundGap = undefined;
hSpaceAroundGapStore.subscribe( value => {hSpaceAroundGap = value;} )

let cnn = undefined;
cnnStore.subscribe( value => {cnn = value;} )

let nodeCoordinate = undefined;
nodeCoordinateStore.subscribe( value => {nodeCoordinate = value;} )

let selectedScaleLevel = undefined;
selectedScaleLevelStore.subscribe( value => {selectedScaleLevel = value;} )

let cnnLayerRanges = undefined;
cnnLayerRangesStore.subscribe( value => {console.log(value, selectedScaleLevel); cnnLayerRanges = value;} )

/**
 * Use bounded d3 data to draw one canvas.
 * @param {object} d d3 data
 * @param {index} i d3 data index
 * @param {[object]} g d3 group
 * @param {number} range color range map (max - min)
 */
export const drawOutput = (d, i, g, range) => {
  let canvas = g[i];

  let context = canvas.getContext('2d');
  let colorScale = layerColorScales[d.type];

  if (d.type === 'input') {
    colorScale = colorScale[d.index];
  }

  // Specially handle the output layer (one canvas is just one color fill)
  if (d.layerName === 'output') {
    context.fillStyle = colorScale(d.output);
    context.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Set up a second convas in order to resize image
  let imageLength = d.output.length === undefined ? 1 : d.output.length;
  let bufferCanvas = document.createElement("canvas");
  let bufferContext = bufferCanvas.getContext("2d");
  bufferCanvas.width = imageLength;
  bufferCanvas.height = imageLength;

  // Fill image pixel array
  let imageSingle = bufferContext.getImageData(0, 0, imageLength, imageLength);
  let imageSingleArray = imageSingle.data;

  if (imageLength === 1) {
    imageSingleArray[0] = d.output;
  } else {
    for (let i = 0; i < imageSingleArray.length; i+=4) {
      let pixeIndex = Math.floor(i / 4);
      let row = Math.floor(pixeIndex / imageLength);
      let column = pixeIndex % imageLength;
      let color = undefined;
      if (d.type === 'input' || d.type === 'fc' ) {
        color = d3.rgb(colorScale(1 - d.output[row][column]))
      } else {
        color = d3.rgb(colorScale((d.output[row][column] + range / 2) / range));
      }

      imageSingleArray[i] = color.r;
      imageSingleArray[i + 1] = color.g;
      imageSingleArray[i + 2] = color.b;
      imageSingleArray[i + 3] = 255;
    }
  }

  // Use drawImage to resize the original pixel array, and put the new image
  // (canvas) into corresponding canvas
  bufferContext.putImageData(imageSingle, 0, 0);
  context.drawImage(bufferCanvas, 0, 0, imageLength, imageLength,
    0, 0, nodeLength, nodeLength);
}

export const drawOutputScore = (d, i, g, scale) => {
  let group = d3.select(g[i]);
  group.select('rect.output-rect')
    .transition('output')
    .delay(500)
    .duration(800)
    .ease(d3.easeCubicIn)
    .attr('width', scale(d.output))
}

export const getLegendGradient = (g, colorScale, gradientName, min, max) => {
  if (min === undefined) { min = 0; }
  if (max === undefined) { max = 1; }
  let gradient = g.append('defs')
    .append('svg:linearGradient')
    .attr('id', `${gradientName}`)
    .attr('x1', '0%')
    .attr('y1', '100%')
    .attr('x2', '100%')
    .attr('y2', '100%')
    .attr('spreadMethod', 'pad');
  let interpolation = 10
  for (let i = 0; i < interpolation; i++) {
    let curProgress = i / (interpolation - 1);
    let curColor = colorScale(curProgress * (max - min) + min);
    gradient.append('stop')
      .attr('offset', `${curProgress * 100}%`)
      .attr('stop-color', curColor)
      .attr('stop-opacity', 1);
  }
}

/**
 * Move one layer horizontally
 * @param {object} arg Multiple arguments {
 *   layerIndex: current layer index
 *   targetX: destination x
 *   disable: make this layer unresponsible
 *   delay: animation delay
 *   opacity: change the current layer's opacity
 *   specialIndex: avoid manipulating `specialIndex`th node
 *   onEndFunc: call this function when animation finishes
 *   transitionName: animation ID
 * }
 */
export const moveLayerX = (arg) => {
  let layerIndex = arg.layerIndex;
  let targetX = arg.targetX;
  let disable = arg.disable;
  let delay = arg.delay;
  let opacity = arg.opacity;
  let specialIndex = arg.specialIndex;
  let onEndFunc = arg.onEndFunc;
  let transitionName = arg.onEndFunc === undefined ? 'move': arg.onEndFunc;

  // Move the selected layer
  let curLayer = svg.select(`g#cnn-layer-group-${layerIndex}`);
  curLayer.selectAll('g.node-group').each((d, i, g) => {
    d3.select(g[i])
      .style('cursor', disable && i !== specialIndex ? 'default' : 'pointer')
      .style('pointer-events', disable && i !== specialIndex ? 'none' : 'all')
      .select('foreignObject')
      .transition(transitionName)
      .ease(d3.easeCubicInOut)
      .delay(delay)
      .duration(500)
      .attr('x', targetX);
    
    d3.select(g[i])
      .select('rect.bounding')
      .transition(transitionName)
      .ease(d3.easeCubicInOut)
      .delay(delay)
      .duration(500)
      .attr('x', targetX);
    
    if (opacity !== undefined && i !== specialIndex) {
      d3.select(g[i])
        .select('foreignObject')
        .style('opacity', opacity);
    }
  });
  
  // Also move the layer labels
  svg.selectAll(`g#layer-label-${layerIndex}`)
    .transition(transitionName)
    .ease(d3.easeCubicInOut)
    .delay(delay)
    .duration(500)
    .attr('transform', () => {
      let x = targetX + nodeLength / 2;
      let y = (svgPaddings.top + vSpaceAroundGap) / 2;
      return `translate(${x}, ${y})`;
    })
    .on('end', onEndFunc);

  svg.selectAll(`g#layer-detailed-label-${layerIndex}`)
    .transition(transitionName)
    .ease(d3.easeCubicInOut)
    .delay(delay)
    .duration(500)
    .attr('transform', () => {
      let x = targetX + nodeLength / 2;
      let y = (svgPaddings.top + vSpaceAroundGap) / 2 - 6;
      return `translate(${x}, ${y})`;
    })
    .on('end', onEndFunc);
}

/**
 * Append a gradient definition to `group`
 * @param {string} gradientID CSS ID for the gradient def
 * @param {[{offset: number, color: string, opacity: number}]} stops Gradient stops
 * @param {element} group Element to append def to
 */
export const addOverlayGradient = (gradientID, stops, group) => {
  if (group === undefined) {
    group = svg;
  }

  // Create a gradient
  let defs = group.append("defs")
    .attr('class', 'overlay-gradient');

  let gradient = defs.append("linearGradient")
    .attr("id", gradientID)
    .attr("x1", "0%")
    .attr("x2", "100%")
    .attr("y1", "100%")
    .attr("y2", "100%");
  
  stops.forEach(s => {
    gradient.append('stop')
      .attr('offset', s.offset)
      .attr('stop-color', s.color)
      .attr('stop-opacity', s.opacity);
  })
}

/**
 * Draw the intermediate layer activation heatmaps
 * @param {element} context Neuron heatmap canvas context
 * @param {number} range Colormap range
 * @param {function} colorScale Colormap
 * @param {number} length Image length
 * @param {[[number]]} dataMatrix Heatmap matrix
 */
export const drawIntermidiateCanvas = (context, range, colorScale, length,
  dataMatrix) => {
  // Set up a second convas in order to resize image
  let imageLength = length;
  let bufferCanvas = document.createElement("canvas");
  let bufferContext = bufferCanvas.getContext("2d");
  bufferCanvas.width = imageLength;
  bufferCanvas.height = imageLength;

  // Fill image pixel array
  let imageSingle = bufferContext.getImageData(0, 0, imageLength, imageLength);
  let imageSingleArray = imageSingle.data;

  for (let i = 0; i < imageSingleArray.length; i+=4) {
    let pixeIndex = Math.floor(i / 4);
    let row = Math.floor(pixeIndex / imageLength);
    let column = pixeIndex % imageLength;
    let color = d3.rgb(colorScale((dataMatrix[row][column] + range / 2) / range));

    imageSingleArray[i] = color.r;
    imageSingleArray[i + 1] = color.g;
    imageSingleArray[i + 2] = color.b;
    imageSingleArray[i + 3] = 255;
  }

  // Use drawImage to resize the original pixel array, and put the new image
  // (canvas) into corresponding canvas
  bufferContext.putImageData(imageSingle, 0, 0);
  context.drawImage(bufferCanvas, 0, 0, imageLength, imageLength,
    0, 0, nodeLength, nodeLength);
}

/**
 * Create a node group for the intermediate layer
 * @param {number} curLayerIndex Intermediate layer index
 * @param {number} selectedI Clicked node index
 * @param {element} groupLayer Group element
 * @param {number} x Node's x
 * @param {number} y Node's y
 * @param {number} nodeIndex Node's index
 * @param {function} intermediateNodeMouseOverHandler Mouse over handler
 * @param {function} intermediateNodeMouseLeaveHandler Mouse leave handler
 * @param {function} intermediateNodeClicked Mouse click handler
 * @param {bool} interaction Whether support interaction
 */
const createIntermediateNode = (curLayerIndex, selectedI, groupLayer, x, y,
  nodeIndex, intermediateNodeMouseOverHandler, intermediateNodeMouseLeaveHandler,
  intermediateNodeClicked, interaction) => {
  let newNode = groupLayer.append('g')
    .datum(cnn[curLayerIndex - 1][nodeIndex])
    .attr('class', 'intermediate-node')
    .attr('cursor', interaction ? 'pointer': 'default')
    .attr('pointer-events', interaction ? 'all': 'none')
    .attr('node-index', nodeIndex)
    .on('mouseover', intermediateNodeMouseOverHandler)
    .on('mouseleave', intermediateNodeMouseLeaveHandler)
    .on('click', (d, g, i) => intermediateNodeClicked(d, g, i, selectedI, curLayerIndex));
  
  newNode.append('foreignObject')
    .attr('width', nodeLength)
    .attr('height', nodeLength)
    .attr('x', x)
    .attr('y', y)
    .append('xhtml:body')
    .style('margin', 0)
    .style('padding', 0)
    .style('background-color', 'none')
    .style('width', '100%')
    .style('height', '100%')
    .append('canvas')
    .attr('class', 'node-canvas')
    .attr('width', nodeLength)
    .attr('height', nodeLength);

  // Add a rectangle to show the border
  newNode.append('rect')
    .attr('class', 'bounding')
    .attr('width', nodeLength)
    .attr('height', nodeLength)
    .attr('x', x)
    .attr('y', y)
    .style('fill', 'none')
    .style('stroke', intermediateColor)
    .style('stroke-width', 1);
  
  return newNode;
}

/**
 * Color scale wrapper (support artificially lighter color!)
 * @param {function} colorScale D3 color scale function
 * @param {number} range Color range (max - min)
 * @param {number} value Color value
 * @param {number} gap Tail of the color scale to skip
 */
export const gappedColorScale = (colorScale, range, value, gap) => {
  if (gap === undefined) { gap = 0; }
  let normalizedValue = (value + range / 2) / range;
  return colorScale(normalizedValue * (1 - 2 * gap) + gap);
}

/**
 * Draw one intermediate layer
 * @param {number} curLayerIndex 
 * @param {number} leftX X value of intermediate layer left border
 * @param {number} rightX X value of intermediate layer right border
 * @param {number} rightStart X value of right component starting anchor
 * @param {number} intermediateGap The inner gap
 * @param {number} d Clicked node bounded data
 * @param {number} i Clicked node index
 * @param {function} intermediateNodeMouseOverHandler Mouse over handler
 * @param {function} intermediateNodeMouseLeaveHandler Mouse leave handler
 * @param {function} intermediateNodeClicked Mouse click handler
 */
export const drawIntermediateLayer = (curLayerIndex, leftX, rightX, rightStart,
  intermediateGap, d, i, intermediateNodeMouseOverHandler,
  intermediateNodeMouseLeaveHandler, intermediateNodeClicked) => {
  // Add the intermediate layer
  let intermediateLayer = svg.select('.cnn-group')
    .append('g')
    .attr('class', 'intermediate-layer')
    .style('opacity', 0);
  
  // Tried to add a rectangle to block the intermediate because of webkit's
  // horrible support (decade old bug) for foreignObject. It doesnt work either.
  // https://bugs.webkit.org/show_bug.cgi?id=23113
  // (1). ForeignObject's inside position is wrong on webkit
  // (2). 'opacity' of ForeignObject doesn't work on webkit
  // (3). ForeignObject always show up at the front regardless the svg
  //      stacking order on webkit

  let intermediateX1 = leftX + nodeLength + intermediateGap;
  let intermediateX2 = intermediateX1 + nodeLength + intermediateGap * 1.5;

  let range = cnnLayerRanges[selectedScaleLevel][curLayerIndex];
  let colorScale = layerColorScales[d.type];
  let intermediateMinMax = [];
  
  // Copy the previsious layer to construct foreignObject placeholder
  // Also add edges from/to the intermediate layer in this loop
  let linkData = [];

  // Accumulate the intermediate sum
  // let itnermediateSumMatrix = init2DArray(d.output.length,
  //  d.output.length, 0);

  // Compute the min max of all kernel weights in the intermediate layer
  let kernelExtents = d.inputLinks.map(link => getExtent(link.weight));
  let kernelExtent = kernelExtents.reduce((acc, cur) => {
    return [Math.min(acc[0], cur[0]), Math.max(acc[1], cur[1])];
  })
  let kernelRange = 2 * (Math.round(
    Math.max(...kernelExtent.map(Math.abs)) * 1000) / 1000);
  let kernelColorGap = 0.2;

  // First intermediate layer
  nodeCoordinate[curLayerIndex - 1].forEach((n, ni) => {

    // Compute the intermediate value
    let inputMatrix = cnn[curLayerIndex - 1][ni].output;
    let kernelMatrix = cnn[curLayerIndex][i].inputLinks[ni].weight;
    let interMatrix = singleConv(inputMatrix, kernelMatrix);

    // Compute the intermediate layer min max
    intermediateMinMax.push(getExtent(interMatrix));

    // Update the intermediate sum
    // itnermediateSumMatrix = matrixAdd(itnermediateSumMatrix, interMatrix);

    // Layout the canvas and rect
    let newNode = createIntermediateNode(curLayerIndex, i, intermediateLayer,
      intermediateX1, n.y, ni, intermediateNodeMouseOverHandler,
      intermediateNodeMouseLeaveHandler, intermediateNodeClicked, true);
    
    // Draw the canvas
    let context = newNode.select('canvas').node().getContext('2d');
    drawIntermidiateCanvas(context, range, colorScale, d.output.length,
      interMatrix);      

    // Edge: input -> intermediate1
    linkData.push({
      source: getOutputKnot({x: leftX, y: n.y}),
      target: getInputKnot({x: intermediateX1, y: n.y}),
      name: `input-${ni}-inter1-${ni}`
    });

    // Edge: intermediate1 -> intermediate2-1
    linkData.push({
      source: getOutputKnot({x: intermediateX1, y: n.y}),
      target: getInputKnot({x: intermediateX2,
        y: nodeCoordinate[curLayerIndex][i].y}),
      name: `inter1-${ni}-inter2-1`
    });

    // Create a small kernel illustration
    // Here we minus 2 because of no padding
    let tickTime1D = nodeLength / kernelRectLength - 2;
    let kernelRectX = leftX - kernelRectLength * 3 * 2;
    let kernelGroup = intermediateLayer.append('g')
      .attr('class', `kernel-${i}`)
      .attr('transform', `translate(${kernelRectX}, ${n.y})`);

    for (let r = 0; r < kernelMatrix.length; r++) {
      for (let c = 0; c < kernelMatrix[0].length; c++) {
        kernelGroup.append('rect')
          .attr('class', 'kernel')
          .attr('x', kernelRectLength * c)
          .attr('y', kernelRectLength * r)
          .attr('width', kernelRectLength)
          .attr('height', kernelRectLength)
          .attr('fill', gappedColorScale(layerColorScales.weight, kernelRange,
            kernelMatrix[r][c], kernelColorGap));
      }
    }

    kernelGroup.append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', kernelRectLength * 3)
      .attr('height', kernelRectLength * 3)
      .attr('fill', 'none')
      .attr('stroke', intermediateColor);

    // Sliding the kernel on the input channel and result channel at the same
    // time
    let kernelGroupInput = kernelGroup.clone(true);
    kernelGroupInput.style('opacity', 0.9)
      .selectAll('rect.kernel')
      .style('opacity', 0.7);

    kernelGroupInput.attr('transform',
      `translate(${leftX}, ${n.y})`)
      .attr('data-tick', 0)
      .attr('data-origin-x', leftX)
      .attr('data-origin-y', n.y);

    let kernelGroupResult = kernelGroup.clone(true);
    kernelGroupResult.style('opacity', 0.9)
      .selectAll('rect.kernel')
      .style('fill', 'none');

    kernelGroupResult.attr('transform',
      `translate(${intermediateX1}, ${n.y})`)
      .attr('data-origin-x', intermediateX1)
      .attr('data-origin-y', n.y);
    
    const slidingAnimation = () => {
      let originX = +kernelGroupInput.attr('data-origin-x');
      let originY = +kernelGroupInput.attr('data-origin-y');
      let originXResult = +kernelGroupResult.attr('data-origin-x');
      let oldTick = +kernelGroupInput.attr('data-tick');
      let x = originX + (oldTick % tickTime1D) * kernelRectLength;
      let y = originY + Math.floor(oldTick / tickTime1D) * kernelRectLength;
      let xResult = originXResult + (oldTick % tickTime1D) * kernelRectLength;

      kernelGroupInput.attr('data-tick', (oldTick + 1) % (tickTime1D * tickTime1D))
        .transition('window-sliding-input')
        .delay(800)
        .duration(0)
        .attr('transform', `translate(${x}, ${y})`);

      kernelGroupResult.attr('data-tick', (oldTick + 1) % (tickTime1D * tickTime1D))
        .transition('window-sliding-result')
        .delay(800)
        .duration(0)
        .attr('transform', `translate(${xResult}, ${y})`)
        .on('end', slidingAnimation);
    }

    slidingAnimation();
  });

  // Aggregate the intermediate min max
  let aggregatedExtent = intermediateMinMax.reduce((acc, cur) => {
    return [Math.min(acc[0], cur[0]), Math.max(acc[1], cur[1])];
  })
  let aggregatedMinMax = {min: aggregatedExtent[0], max: aggregatedExtent[1]};

  // Draw the plus operation symbol
  let symbolY = nodeCoordinate[curLayerIndex][i].y + nodeLength / 2;
  let symbolRectHeight = 1;
  let symbolGroup = intermediateLayer.append('g')
    .attr('class', 'plus-symbol')
    .attr('transform', `translate(${intermediateX2 + plusSymbolRadius}, ${symbolY})`);
  
  symbolGroup.append('circle')
    .attr('cx', 0)
    .attr('cy', 0)
    .attr('r', plusSymbolRadius)
    .style('fill', 'none')
    .style('stroke', intermediateColor);
  
  symbolGroup.append('rect')
    .attr('x', -(plusSymbolRadius - 3))
    .attr('y', -symbolRectHeight / 2)
    .attr('width', 2 * (plusSymbolRadius - 3))
    .attr('height', symbolRectHeight)
    .style('fill', intermediateColor);

  symbolGroup.append('rect')
    .attr('x', -symbolRectHeight / 2)
    .attr('y', -(plusSymbolRadius - 3))
    .attr('width', symbolRectHeight)
    .attr('height', 2 * (plusSymbolRadius - 3))
    .style('fill', intermediateColor);

  // Place the bias rectangle below the plus sign if user clicks the firrst
  // conv node
  if (i == 0) {
    // Add bias symbol to the plus symbol
    symbolGroup.append('rect')
      .attr('x', -kernelRectLength)
      .attr('y', nodeLength / 2)
      .attr('width', 2 * kernelRectLength)
      .attr('height', 2 * kernelRectLength)
      .style('stroke', intermediateColor)
      .style('fill', gappedColorScale(layerColorScales.weight, kernelRange,
        d.bias, kernelColorGap));
    
    // Link from bias to the plus symbol
    linkData.push({
      source: {x: intermediateX2 + plusSymbolRadius,
        y: nodeCoordinate[curLayerIndex][i].y + nodeLength},
      target: {x: intermediateX2 + plusSymbolRadius,
        y: nodeCoordinate[curLayerIndex][i].y + nodeLength / 2 + plusSymbolRadius},
      name: `bias-plus`
    });
  } else {
    // Add bias symbol to the plus symbol
    symbolGroup.append('rect')
      .attr('x', -kernelRectLength)
      .attr('y', -nodeLength / 2 - 2 * kernelRectLength)
      .attr('width', 2 * kernelRectLength)
      .attr('height', 2 * kernelRectLength)
      .style('stroke', intermediateColor)
      .style('fill', gappedColorScale(layerColorScales.weight, kernelRange,
        d.bias, kernelColorGap));
    
    // Link from bias to the plus symbol
    linkData.push({
      source: {x: intermediateX2 + plusSymbolRadius,
        y: nodeCoordinate[curLayerIndex][i].y},
      target: {x: intermediateX2 + plusSymbolRadius,
        y: nodeCoordinate[curLayerIndex][i].y + nodeLength / 2 - plusSymbolRadius},
      name: `bias-plus`
    });
  }

  // Link from the plus symbol to the output
  linkData.push({
    source: getOutputKnot({x: intermediateX2 + 2 * plusSymbolRadius - nodeLength,
      y: nodeCoordinate[curLayerIndex][i].y}),
    target: getInputKnot({x: rightX,
      y: nodeCoordinate[curLayerIndex][i].y}),
    name: `symbol-output`
  });
  
  // Output -> next layer
  linkData.push({
    source: getOutputKnot({x: rightX,
      y: nodeCoordinate[curLayerIndex][i].y}),
    target: getInputKnot({x: rightStart,
      y: nodeCoordinate[curLayerIndex][i].y}),
    name: `output-next`
  });

  // Draw the layer label
  intermediateLayer.append('g')
    .attr('class', 'layer-intermediate-label')
    .attr('transform', () => {
      let x = leftX + nodeLength + (nodeLength + 2 * plusSymbolRadius + 2 *
        hSpaceAroundGap * gapRatio) / 2;
      let y = (svgPaddings.top + vSpaceAroundGap) / 2;
      return `translate(${x}, ${y})`;
    })
    .append('text')
    .style('dominant-baseline', 'middle')
    .style('opacity', '0.8')
    .text('intermediate')

  // Draw the edges
  let linkGen = d3.linkHorizontal()
    .x(d => d.x)
    .y(d => d.y);
  
  let edgeGroup = intermediateLayer.append('g')
    .attr('class', 'edge-group');
  
  let dashoffset = 0;
  const animateEdge = (d, i, g, dashoffset) => {
    let curPath = d3.select(g[i]);
    curPath.transition()
      .duration(8000)
      .ease(d3.easeLinear)
      .attr('stroke-dashoffset', dashoffset)
      .on('end', (d, i, g) => animateEdge(d, i, g, dashoffset - 160));
  }

  edgeGroup.selectAll('path')
    .data(linkData)
    .enter()
    .append('path')
    .classed('flow-edge', d => d.name !== 'output-next')
    .attr('id', d => `edge-${d.name}`)
    .attr('d', d => linkGen({source: d.source, target: d.target}))
    .style('fill', 'none')
    .style('stroke-width', 1)
    .style('stroke', intermediateColor);

  edgeGroup.select('#edge-output-next')
    .style('opacity', 0.1);
  
  edgeGroup.selectAll('path.flow-edge')
    .attr('stroke-dasharray', '4 2')
    .attr('stroke-dashoffset', 0)
    .each((d, i, g) => animateEdge(d, i, g, dashoffset - 160));
  
  return {intermediateLayer: intermediateLayer,
    intermediateMinMax: aggregatedMinMax,
    kernelRange: kernelRange,
    kernelMinMax: {min: kernelExtent[0], max: kernelExtent[1]}};
}

/**
 * Add an annotation for the kernel and the sliding
 * @param {object} arg 
 * {
 *  leftX: X value of the left border of intermedaite layer
 *  group: element group
 *  intermediateGap: the inner gap of intermediate layer
 *  isFirstConv: if this intermediate layer is after the first layer
 *  i: index of the selected node
 * }
 */
export const drawIntermediateLayerAnnotation = (arg) => {
  let leftX = arg.leftX,
    curLayerIndex = arg.curLayerIndex,
    group = arg.group,
    intermediateGap = arg.intermediateGap,
    isFirstConv = arg.isFirstConv,
    i = arg.i;

  let kernelAnnotation = group.append('g')
    .attr('class', 'kernel-annotation');
  
  kernelAnnotation.append('text')
    .text('Kernel')
    .attr('class', 'annotation-text')
    .attr('x', leftX - 2.5 * kernelRectLength * 3)
    .attr('y', nodeCoordinate[curLayerIndex - 1][0].y + kernelRectLength * 3)
    .style('dominant-baseline', 'baseline')
    .style('text-anchor', 'end');

  let sliderX, sliderY, arrowSX, arrowSY, dr;
  
  if (isFirstConv) {
    sliderX = leftX;
    sliderY = nodeCoordinate[curLayerIndex - 1][0].y + nodeLength +
      kernelRectLength * 3;
    arrowSX = leftX - 5;
    arrowSY = nodeCoordinate[curLayerIndex - 1][0].y + nodeLength +
      kernelRectLength * 3 + 5;
    dr = 20;
  } else {
    sliderX = leftX - 2.5 * kernelRectLength * 3;
    sliderY = nodeCoordinate[curLayerIndex - 1][0].y + nodeLength / 2;
    arrowSX = leftX - 2 * kernelRectLength * 3 - 2;
    arrowSY = nodeCoordinate[curLayerIndex - 1][0].y + nodeLength - 10;
    dr = 40;
  }

  let slideText = kernelAnnotation.append('text')
    .attr('x', sliderX)
    .attr('y', sliderY)
    .attr('class', 'annotation-text')
    .style('dominant-baseline', 'hanging')
    .style('text-anchor', isFirstConv ? 'start' : 'end');
  
  slideText.append('tspan')
    .text('Slide kernel over');

  slideText.append('tspan')
    .attr('x', sliderX)
    .attr('dy', '1em')
    .text('input channel to get');

  slideText.append('tspan')
    .attr('x', sliderX)
    .attr('dy', '1em')
    .text('intermediate result');

  drawArrow({
    group: group,
    tx: leftX - 5,
    ty: nodeCoordinate[curLayerIndex - 1][0].y + nodeLength / 2,
    sx: arrowSX,
    sy: arrowSY,
    dr: dr
  });

  // Add annotation for the sum operation
  let plusAnnotation = group.append('g')
    .attr('class', 'plus-annotation');
  
  let intermediateX2 = leftX + 2 * nodeLength + 2.5 * intermediateGap;
  let textX = intermediateX2;
  let textY = nodeCoordinate[curLayerIndex][i].y + nodeLength +
      kernelRectLength * 3;

  // Special case 1: first node
  if (i === 0) { textX += 30; }

  // Special case 2: last node
  if (i === 9) {
    textX = intermediateX2 + plusSymbolRadius - 10;
    textY -= 2.5 * nodeLength;
  }

  let plusText = plusAnnotation.append('text')
    .attr('x', textX)
    .attr('y', textY)
    .attr('class', 'annotation-text')
    .style('dominant-baseline', 'hanging')
    .style('text-anchor', 'start');
  
  plusText.append('tspan')
    .text('Add up all intermediate');
  
  plusText.append('tspan')
    .attr('x', textX)
    .attr('dy', '1em')
    .text('results and then add bias');
  
  if (i === 9) {
    drawArrow({
      group: group,
      sx: intermediateX2 + 50,
      sy: nodeCoordinate[curLayerIndex][i].y - (nodeLength / 2 + kernelRectLength * 2),
      tx: intermediateX2 + 2 * plusSymbolRadius + 3,
      ty: nodeCoordinate[curLayerIndex][i].y + nodeLength / 2 - plusSymbolRadius,
      dr: 50,
      hFlip: false
    });
  } else {
    drawArrow({
      group: group,
      sx: intermediateX2 + 35,
      sy: nodeCoordinate[curLayerIndex][i].y + nodeLength + kernelRectLength * 2,
      tx: intermediateX2 + 2 * plusSymbolRadius + 3,
      ty: nodeCoordinate[curLayerIndex][i].y + nodeLength / 2 + plusSymbolRadius,
      dr: 30,
      hFlip: true
    });
  }

  // Add annotation for the bias
  let biasTextY = nodeCoordinate[curLayerIndex][i].y;
  if (i === 0) {
    biasTextY += nodeLength + 2 * kernelRectLength;
  } else {
    biasTextY -= 2 * kernelRectLength + 5;
  }
  plusAnnotation.append('text')
    .attr('class', 'annotation-text')
    .attr('x', intermediateX2 + plusSymbolRadius)
    .attr('y', biasTextY)
    .style('text-anchor', 'middle')
    .style('dominant-baseline', i === 0 ? 'hanging' : 'baseline')
    .text('Bias');
}

/**
 * Draw an very neat arrow!
 * @param {object} arg 
 * {
 *   group: element to append this arrow to
 *   sx: source x
 *   sy: source y
 *   tx: target x
 *   ty: target y
 *   dr: radius of curve (I'm using a circle)
 *   hFlip: the direction to choose the circle (there are always two ways)
 * }
 */
const drawArrow = (arg) => {
    let group = arg.group,
      sx = arg.sx,
      sy = arg.sy,
      tx = arg.tx,
      ty = arg.ty,
      dr = arg.dr,
      hFlip = arg.hFlip;

    /* Cool graphics trick -> merge translate and scale together
    translateX = (1 - scaleX) * tx,
    translateY = (1 - scaleY) * ty;
    */
    
    let arrow = group.append('g')
      .attr('class', 'arrow-group');

    arrow.append('path')
      .attr("d", `M${sx},${sy}A${dr},${dr} 0 0,${hFlip ? 0 : 1} ${tx},${ty}`)
      .attr('marker-end', 'url(#marker)')
      .style('stroke', 'gray')
      .style('fill', 'none');
}

/**
 * Draw the legend for intermediate layer
 * @param {object} arg 
 * {
 *   legendHeight: height of the legend rectangle
 *   curLayerIndex: the index of selected layer
 *   range: colormap range
 *   group: group to append the legend
 *   minMax: {min: min value, max: max value}
 *   width: width of the legend
 *   x: x position of the legend
 *   y: y position of the legend
 *   isInput: if the legend is for the input layer (special handle black to
 *      white color scale)
 *   colorScale: d3 color scale
 *   gradientAppendingName: name of the appending gradient
 *   gradientGap: gap to make the color lighter
 * }
 */
export const drawIntermediateLayerLegend = (arg) => {
  let legendHeight = arg.legendHeight,
    curLayerIndex = arg.curLayerIndex,
    range = arg.range,
    group = arg.group,
    minMax = arg.minMax,
    width = arg.width,
    x = arg.x,
    y = arg.y,
    isInput = arg.isInput,
    colorScale = arg.colorScale,
    gradientAppendingName = arg.gradientAppendingName,
    gradientGap = arg.gradientGap;
  
  if (colorScale === undefined) { colorScale = layerColorScales.conv; }
  if (gradientGap === undefined) { gradientGap = 0; }
  
  // Add a legend color gradient
  let gradientName = 'url(#inputGradient)';
  let normalizedColor = v => colorScale(v * (1 - 2 * gradientGap) + gradientGap);

  if (!isInput) {
    let leftValue = (minMax.min + range / 2) / range,
      zeroValue = (0 + range / 2) / range,
      rightValue = (minMax.max + range / 2) / range,
      totalRange = minMax.max - minMax.min,
      zeroLocation = (0 - minMax.min) / totalRange,
      leftMidValue = leftValue + (zeroValue - leftValue)/2,
      rightMidValue = zeroValue + (rightValue - zeroValue)/2;

    let stops = [
      {offset: 0, color: normalizedColor(leftValue), opacity: 1},
      {offset: zeroLocation / 2,
        color: normalizedColor(leftMidValue),
        opacity: 1},
      {offset: zeroLocation,
        color: normalizedColor(zeroValue),
        opacity: 1},
      {offset: zeroLocation + (1 - zeroValue) / 2,
        color: normalizedColor(rightMidValue),
        opacity: 1},
      {offset: 1, color: normalizedColor(rightValue), opacity: 1}
    ];

    if (gradientAppendingName === undefined) {
      addOverlayGradient('intermediate-legend-gradient', stops, group);
      gradientName = 'url(#intermediate-legend-gradient)';
    } else {
      addOverlayGradient(`${gradientAppendingName}`, stops, group);
      gradientName = `url(#${gradientAppendingName})`;
    }
  }

  let legendScale = d3.scaleLinear()
    .range([0, width - 1.2])
    .domain(isInput ? [0, range] : [minMax.min, minMax.max]);

  let legendAxis = d3.axisBottom()
    .scale(legendScale)
    .tickFormat(d3.format(isInput ? 'd' : '.2f'))
    .tickValues(isInput ? [0, range] : [minMax.min, 0, minMax.max]);
  
  let intermediateLegend = group.append('g')
    .attr('id', `intermediate-legend-${curLayerIndex - 1}`)
    .attr('transform', `translate(${x}, ${y})`);
  
  let legendGroup = intermediateLegend.append('g')
    .attr('transform', `translate(0, ${legendHeight - 3})`)
    .call(legendAxis);
  
  legendGroup.selectAll('text')
    .style('font-size', '9px')
    .style('fill', intermediateColor);
  
  legendGroup.selectAll('path, line')
    .style('stroke', intermediateColor);

  intermediateLegend.append('rect')
    .attr('width', width)
    .attr('height', legendHeight)
    .attr('transform', `rotate(${isInput ? 180 : 0},
      ${width / 2}, ${legendHeight / 2})`)
    .style('fill', gradientName);
}

/**
 * Append a filled rectangle under a pair of nodes.
 * @param {number} curLayerIndex Index of the selected layer
 * @param {number} i Index of the selected node
 * @param {number} leftX X value of the left border of intermediate layer
 * @param {number} intermediateGap Inner gap of this intermediate layer
 * @param {number} padding Padding around the rect
 * @param {function} intermediateNodeMouseOverHandler Mouse over handler
 * @param {function} intermediateNodeMouseLeaveHandler Mouse leave handler
 * @param {function} intermediateNodeClicked Mouse click handler
 */
export const addUnderneathRect = (curLayerIndex, i, leftX,
  intermediateGap, padding, intermediateNodeMouseOverHandler,
  intermediateNodeMouseLeaveHandler, intermediateNodeClicked) => {
  // Add underneath rects
  let underGroup = svg.select('g.underneath');
  for (let n = 0; n < cnn[curLayerIndex - 1].length; n++) {
    underGroup.append('rect')
      .attr('class', 'underneath-gateway')
      .attr('id', `underneath-gateway-${n}`)
      .attr('x', leftX - padding)
      .attr('y', nodeCoordinate[curLayerIndex - 1][n].y - padding)
      .attr('width', (2 * nodeLength + intermediateGap) + 2 * padding)
      .attr('height', nodeLength + 2 * padding)
      .attr('rx', 10)
      .style('fill', 'rgba(160, 160, 160, 0.2)')
      .style('opacity', 0);
    
    // Register new events for input layer nodes
    svg.select(`g#layer-${curLayerIndex - 1}-node-${n}`)
      .on('mouseover', intermediateNodeMouseOverHandler)
      .on('mouseleave', intermediateNodeMouseLeaveHandler)
      .on('click', (d, g, ni) => intermediateNodeClicked(d, g, ni,
        i, curLayerIndex))
  }
  underGroup.lower();
}

/**
 * Add an overlaying rect
 * @param {string} gradientName Gradient name of overlay rect
 * @param {number} x X value of the overlaying rect
 * @param {number} y Y value of the overlaying rect
 * @param {number} width Rect width
 * @param {number} height Rect height
 */
export const addOverlayRect = (gradientName, x, y, width, height) => {
  if (svg.select('.intermediate-layer-overlay').empty()) {
    svg.append('g').attr('class', 'intermediate-layer-overlay');
  }

  let intermediateLayerOverlay = svg.select('.intermediate-layer-overlay');

  let overlayRect = intermediateLayerOverlay.append('rect')
    .attr('class', 'overlay')
    .style('fill', `url(#${gradientName})`)
    .style('stroke', 'none')
    .attr('width', width)
    .attr('height', height)
    .attr('x', x)
    .attr('y', y)
    .style('opacity', 0);
  
  overlayRect.transition('move')
    .duration(800)
    .ease(d3.easeCubicInOut)
    .style('opacity', 1);
}